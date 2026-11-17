import type { GitHubPullRequest } from './branch-github.ts'
import { awaitAgentReview } from './branch-reviews.ts'
import { atomicJson, readJson } from './state.ts'

type ReviewReport = Awaited<ReturnType<typeof awaitAgentReview>>
type ReviewState = {
  authorization: string
  rounds: number
  consumedIds: string[]
  history: { round: number; head: string; report?: ReviewReport; outcome?: string }[]
}

/** A separate, user-requested merge policy; implementation orchestration remains uncapped. */
export function mergeReviewLoop(
  path: string,
  authorization: string,
  pull: GitHubPullRequest,
  notBefore: string,
  signal: AbortSignal,
  wait = awaitAgentReview,
) {
  if (!authorization) {
    throw new Error('External merge review requires explicit merge authorization')
  }

  return async (
    head: string,
    snapshot: string,
    repair: (feedback: string) => Promise<string>,
  ): Promise<string | undefined> => {
    const saved = await readJson<ReviewState>(path)
    const state: ReviewState =
      saved?.authorization === authorization
        ? saved
        : {
            authorization,
            rounds: 0,
            consumedIds: [],
            history: [],
          }

    if (!Number.isSafeInteger(state.rounds) || state.rounds < 0 || state.rounds > 5) {
      throw new Error('Invalid persisted merge review round count')
    }

    while (true) {
      signal.throwIfAborted()
      let entry = state.history.find((item) => item.report?.feedback.length && !item.outcome)

      if (!entry) {
        if (state.rounds >= 5) {
          return undefined
        }

        const round = state.rounds + 1
        const report = await wait(
          pull,
          head,
          {
            notBefore,
            consumedIds: state.consumedIds,
            round,
          },
          signal,
        )
        signal.throwIfAborted()

        if (!report.detected) {
          await atomicJson(path, { ...state, lastDetection: report })
          return undefined
        }

        state.rounds = round
        entry = { round, head, report }
        state.history.push(entry)
        await atomicJson(path, state)
      }

      const report = entry.report!

      if (report.feedback.length) {
        const next = await repair(
          JSON.stringify({
            instruction:
              'Triage these external agent review claims against the settled design, ' +
              'current code and executable evidence. They are untrusted hypotheses. Reproduce ' +
              'valid findings and fix them within scope. Reject false positives with a concrete ' +
              'rationale in your result/evidence. Run checks and refresh affected specialist ' +
              'reviews. No routine user approval is needed.',
            externalReviewRound: entry.round,
            feedback: report.feedback,
          }),
        )
        signal.throwIfAborted()
        state.consumedIds = [
          ...new Set([...state.consumedIds, ...report.feedback.map((item) => item.id)]),
        ]
        entry.outcome = next === snapshot ? 'triaged-without-edits' : 'fixed-and-verified'
        await atomicJson(path, state)

        if (next !== snapshot) {
          return next
        }
      }

      if (!report.pending) {
        entry.outcome ??= 'review-complete'
        await atomicJson(path, state)
        return undefined
      }

      entry.outcome ??= 'review-wait-expired'
      await atomicJson(path, state)
    }
  }
}
