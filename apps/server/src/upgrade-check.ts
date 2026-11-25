import type {
  ReleaseCompareApi,
  ReleaseCompareCheck,
  ReleaseCompareCheckStart,
} from '@holtkeeper/api'
import { renderDependencyDiff } from '@holtkeeper/dep-diff'
import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisRecord, Job, Store } from '@holtkeeper/store'
import {
  UPGRADE_CHECK_KIND,
  type UpgradeCheckDeps,
  upgradeCheckDataSchema,
  upgradeCheckOptionsSchema,
  upgradeCheckRef,
} from '@holtkeeper/upgrade-check'
import { z } from 'zod'

import { aiLanguageOf } from './ai-language.ts'
import type { ServerDeps } from './context.ts'
import { type CompareRangeEnd, releaseServiceFor } from './releases.ts'

const JOB_SCAN = 200
const RECORD_SCAN = 50

/**
 * The public API changes of a range as the breaking-change check's agents read them: each changed
 * package with its versions and diff, then the packages without a record. `undefined` when the
 * repository has no `api-surface` records.
 */
export function renderApiChanges(api: Omit<ReleaseCompareApi, 'backfill'>): string | undefined {
  if (!api.recorded) return undefined
  const blocks = api.packages.map((pkg) => {
    const versions = pkg.from || pkg.to ? ` (${pkg.from ?? 'new'} → ${pkg.to ?? 'removed'})` : ''
    return [`### ${pkg.name}${versions}`, pkg.markdown.trim()].filter(Boolean).join('\n\n')
  })
  if (api.missing.length)
    blocks.push(
      `Not recorded: ${api.missing.map((item) => `${item.name} (${item.side})`).join(', ')}.`,
    )
  return blocks.length ? blocks.join('\n\n') : 'No export of the repository’s own packages changed.'
}

/**
 * The `inputsFor` hook of the server's `upgrade-check` analyzer: the public API changes
 * (`renderApiChanges`) and dependency changes of exactly the commits the job checks, read by the
 * release service. The ends are read by their labels (version tags, the target branch) only while
 * those still resolve to the job's commits, so records stored under a tag are found; once a branch
 * moved or a tag was moved, they are read between the commits.
 */
export function upgradeCheckInputs(
  deps: () => ServerDeps,
): NonNullable<UpgradeCheckDeps['inputsFor']> {
  return async (repo, { from, to }) => {
    const releases = releaseServiceFor(deps())
    const labels = { from: from.label ?? from.sha, to: to.label ?? to.sha }
    const shas = { from: from.sha, to: to.sha }
    const ends = await releases.compareRange(repo, labels).catch(() => undefined)
    const byLabel = ends?.from.sha === from.sha && ends.to.sha === to.sha
    const found = await releases.changesWithDependencies(repo, byLabel ? labels : shas, {
      publicApi: true,
    })
    const apiChanges = found.publicApi ? renderApiChanges(found.publicApi) : undefined
    const dependencyChanges = found.dependencies
      ? renderDependencyDiff(found.dependencies)
      : undefined
    return {
      ...(apiChanges && { apiChanges }),
      ...(dependencyChanges && { dependencyChanges }),
    }
  }
}

const DEFAULT_LANGUAGE = 'English'
const writtenLanguage = z.object({ language: z.string().optional() })

const sameLanguage = (a: string | undefined, b: string) =>
  (a ?? DEFAULT_LANGUAGE).toLowerCase() === b.toLowerCase()

const covers = (job: Job, fromSha: string, toSha: string, language: string) =>
  job.options.from === fromSha &&
  job.options.to === toSha &&
  sameLanguage(
    typeof job.options.language === 'string' ? job.options.language : undefined,
    language,
  )

const isActive = (job: Job) => job.status === 'queued' || job.status === 'running'

async function rangeJobs(
  store: Store,
  repo: RepoRef,
  fromSha: string,
  toSha: string,
  language: string,
) {
  const jobs = await store.jobs.list({ repo, analyzer: UPGRADE_CHECK_KIND, limit: JOB_SCAN })
  return jobs.filter((job) => covers(job, fromSha, toSha, language))
}

async function rangeRecord(
  store: Store,
  repo: RepoRef,
  fromSha: string,
  toSha: string,
  language: string,
): Promise<AnalysisRecord | undefined> {
  const ref = upgradeCheckRef(fromSha, toSha)
  const heads = await store.analyses.heads({ repo, kind: UPGRADE_CHECK_KIND, limit: RECORD_SCAN })
  for (const head of heads.filter((item) => item.ref === ref)) {
    // oxlint-disable-next-line no-await-in-loop -- newest first, usually the first one matches
    const record = await store.analyses.get(head.id)
    const written = writtenLanguage.safeParse(record?.data).data?.language
    if (record && sameLanguage(written, language)) return record
  }
  return undefined
}

/**
 * Where the breaking-change check of `fromSha..toSha` stands (`ReleaseCompareCheck`): a queued or
 * running job of the range wins; then a failed or budget-stopped job newer than the newest
 * finished record (`failed`, with that record when there is one); then the newest record
 * (`done`); else `none`. Canceled jobs are ignored. Only jobs and records written in `language`
 * (default English; records without one count as English) are considered, so a check in another
 * language reads as `none`.
 */
export async function upgradeCheckStatus(
  store: Store,
  repo: RepoRef,
  fromSha: string,
  toSha: string,
  language = DEFAULT_LANGUAGE,
): Promise<ReleaseCompareCheck> {
  const [jobs, record] = await Promise.all([
    rangeJobs(store, repo, fromSha, toSha, language),
    rangeRecord(store, repo, fromSha, toSha, language),
  ])
  const active = jobs.find(isActive)
  if (active)
    return { status: active.status === 'running' ? 'running' : 'queued', jobId: active.id }
  const parsed = record ? upgradeCheckDataSchema.safeParse(record.data) : undefined
  const done = record
    ? { analysisId: record.id, ...(parsed?.success && { data: parsed.data }) }
    : undefined
  const latest = jobs.find((job) => job.status !== 'canceled')
  if (
    latest &&
    (latest.status === 'failed' || latest.status === 'blocked') &&
    (!record || (latest.finishedAt ?? latest.createdAt) > record.createdAt)
  )
    return {
      status: 'failed',
      jobId: latest.id,
      ...(latest.error && { error: latest.error }),
      ...done,
    }
  if (done) return { status: 'done', ...done }
  return { status: 'none' }
}

/** What `startUpgradeCheck` queues. */
export interface UpgradeCheckRequest {
  repo: RepoRef
  from: CompareRangeEnd
  to: CompareRangeEnd
  /** Principal id of whoever asked. */
  actor: string
  /** Queue a new run even when a finished check of the same commits exists. */
  force?: boolean
  /** Language of the check's texts; the repository's AI language (`aiLanguageOf`) when absent. */
  language?: string
}

/**
 * Queues the breaking-change check of `from.sha..to.sha` (analyzer `upgrade-check`, `ref` the `to`
 * commit, trigger `manual`, one attempt) in the request's language unless a finished record of the
 * same commits in that language exists (returned as `existing` without `force`) or a queued or
 * running job already checks them in it (its id is returned). Jobs of the same `to` commit with
 * another start or language are separate runs.
 */
export async function startUpgradeCheck(
  deps: Pick<ServerDeps, 'store' | 'now' | 'config'>,
  request: UpgradeCheckRequest,
): Promise<ReleaseCompareCheckStart> {
  const { store } = deps
  const { repo, from, to } = request
  const language = request.language ?? (await aiLanguageOf(deps, repo))
  if (!request.force) {
    const record = await rangeRecord(store, repo, from.sha, to.sha, language)
    if (record) {
      const [producer] = await store.jobs.list({ analysisId: record.id, limit: 1 })
      return { existing: record.id, ...(producer && { jobId: producer.id }) }
    }
  }
  const active = (await rangeJobs(store, repo, from.sha, to.sha, language)).find(isActive)
  if (active) return { jobId: active.id }
  const job = await store.jobs.enqueue({
    analyzer: UPGRADE_CHECK_KIND,
    repo,
    ref: to.sha,
    options: upgradeCheckOptionsSchema.parse({
      from: from.sha,
      to: to.sha,
      fromLabel: from.label,
      toLabel: to.label,
      language,
    }),
    trigger: 'manual',
    maxAttempts: 1,
    createdAt: deps.now().toISOString(),
    actor: request.actor,
    reason: `breaking-change check ${from.label}..${to.label}`,
  })
  return { jobId: job.id }
}
