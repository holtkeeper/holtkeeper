import type { ReviewDetail, ReviewList, ReviewQuality } from '@holtkeeper/api'
import { qualityGroups, reviewDataSchema } from '@holtkeeper/review'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import {
  type Env,
  type ServerDeps,
  authorize,
  authorizeRecord,
  parseRepo,
  principalOf,
  readQuery,
  repoTarget,
} from '../context.ts'
import { REVIEWS_LIMIT, listReviews, reviewDetail, reviewQuality } from '../reviews.ts'
import { canSee } from '../visibility.ts'

const DAY_MS = 86_400_000

/** Days `GET /reviews/quality` looks back when `since` is not given. */
const QUALITY_DAYS = 90

const qualityQuerySchema = z.object({
  by: z.enum(qualityGroups).default('category'),
  since: z.iso.datetime().optional(),
  group: z.string().min(1).optional(),
})

const querySchema = z.object({
  verdict: z.enum(['looks-good', 'needs-changes', 'skipped']).optional(),
  since: z.iso.datetime().optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).optional(),
  group: z.string().min(1).optional(),
})

/**
 * Quality › Reviews: `GET /reviews` lists review runs newest first (`ReviewQuery`, default the
 * last 30 days, at most 200 rows) on repositories the caller may read analyses of, from stored
 * metrics; `GET /reviews/:id` is one run with its findings, 404 when the record is not a review or
 * its repository is hidden from the caller. `GET /reviews/quality` says how the comments fared
 * (`ReviewQuality`): per category, severity, model, prompt version or source, how many ended in
 * changed code, a resolved or an ignored thread, over the last 90 days by default. None of them
 * asks the forge or a model.
 */
export function reviewRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()
  const targetOf = (repo: { forge: string; path: string }) => repoTarget(config, repo)

  app.get('/reviews', async (c) => {
    const query = readQuery(c, querySchema)
    const repo = parseRepo(c.req.query('repo'))
    if (repo) authorize(c, 'analyses:read', { kind: 'repo', repo: targetOf(repo) })
    const principal = principalOf(c)
    return c.json<ReviewList>(
      await listReviews(
        { analyses: store.analyses, targetOf },
        (target) => canSee(principal, 'analyses:read', target),
        {
          ...(repo ? { repo } : {}),
          ...(query.group ? { group: query.group } : {}),
          ...(query.verdict ? { verdict: query.verdict } : {}),
          since: query.since ?? new Date(deps.now().getTime() - 30 * DAY_MS).toISOString(),
          ...(query.before ? { before: query.before } : {}),
          limit: Math.min(query.limit ?? REVIEWS_LIMIT.default, REVIEWS_LIMIT.max),
        },
      ),
    )
  })

  app.get('/reviews/quality', async (c) => {
    const query = readQuery(c, qualityQuerySchema)
    const repo = parseRepo(c.req.query('repo'))
    if (repo) authorize(c, 'analyses:read', { kind: 'repo', repo: targetOf(repo) })
    const principal = principalOf(c)
    return c.json<ReviewQuality>(
      await reviewQuality(
        { learnings: store.learnings, targetOf },
        (target) => canSee(principal, 'analyses:read', target),
        {
          by: query.by,
          ...(repo ? { repo } : {}),
          ...(query.group ? { group: query.group } : {}),
          since:
            query.since ?? new Date(deps.now().getTime() - QUALITY_DAYS * DAY_MS).toISOString(),
        },
      ),
    )
  })

  app.get('/reviews/:id', async (c) => {
    const record = await store.analyses.get(c.req.param('id'))
    const target = record && targetOf(record.repo)
    if (
      !record ||
      !target ||
      record.kind !== 'review' ||
      !canSee(principalOf(c), 'analyses:read', target)
    )
      throw new HTTPException(404, { message: 'review not found' })
    authorizeRecord(c, 'analyses:read', { kind: 'repo', repo: target })
    const data = reviewDataSchema.safeParse(record.data).data
    if (!data) throw new HTTPException(404, { message: 'review not found' })
    return c.json<ReviewDetail>(reviewDetail(record, data))
  })

  return app
}
