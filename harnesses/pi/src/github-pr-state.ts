import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { githubCommand, type GitHubCommand } from './branch-github.ts'

const query =
  'query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){' +
  'pullRequest(number:$n){number state headRefOid isInMergeQueue mergeable mergeStateStatus}}}'
const schema = Type.Object({
  number: Type.Integer(),
  state: Type.String(),
  headRefOid: Type.String({ pattern: '^[0-9a-f]{40}$' }),
  isInMergeQueue: Type.Boolean(),
  mergeable: Type.String(),
  mergeStateStatus: Type.String(),
})

export async function githubPrState(
  repository: string,
  number: number,
  signal?: AbortSignal,
  run: GitHubCommand = githubCommand,
) {
  const [owner, repo] = repository.split('/')
  const raw = await run(
    [
      'api',
      'graphql',
      '--hostname',
      'github.com',
      '-f',
      'query=' + query,
      '-f',
      'owner=' + owner,
      '-f',
      'repo=' + repo,
      '-F',
      'n=' + number,
      '--jq',
      '.data.repository.pullRequest',
    ],
    signal,
  )
  const state: unknown = JSON.parse(raw)

  if (!Check(schema, state) || state.number !== number) {
    throw new Error('Unable to verify GitHub pull request and queue state')
  }

  return state
}
