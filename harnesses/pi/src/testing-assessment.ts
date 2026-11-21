import { Type, type Static } from 'typebox'

const reason = Type.String({ minLength: 1, maxLength: 600, pattern: '\\S' })
const points = Type.Integer({ minimum: 0, maximum: 2 })
const rating = Type.Object({ points, evidence: reason }, { additionalProperties: false })
const exemption = Type.Object({ inapplicable: reason }, { additionalProperties: false })
const conditional = Type.Union([rating, exemption])

export const engineeringReviewSchema = Type.Object(
  {
    tigerStyle: reason,
    testing: Type.Union([
      Type.Object(
        {
          productionPath: rating,
          invariants: rating,
          exploration: rating,
          recovery: conditional,
          replay: conditional,
          browserJourney: conditional,
        },
        { additionalProperties: false },
      ),
      Type.Object({ unscored: reason }, { additionalProperties: false }),
    ]),
  },
  { additionalProperties: false },
)

export type EngineeringReview = Static<typeof engineeringReviewSchema>

export function testingScore(review: EngineeringReview): number | null {
  if ('unscored' in review.testing) {
    return null
  }

  const ratings = Object.values(review.testing).filter((r) => 'points' in r)
  const earned = ratings.reduce((sum, r) => sum + r.points, 0)
  return Math.round((100 * earned) / (2 * ratings.length))
}
