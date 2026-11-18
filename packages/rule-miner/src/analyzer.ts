import { scopeCoversRepo } from '@holtkeeper/access'
import { defineAnalyzer } from '@holtkeeper/analyzer'
import type { RepoRef } from '@holtkeeper/forge'
import { type Metric, type Report, defineAnalysis, metric } from '@holtkeeper/report'
import {
  DEFAULT_LEARNING_POLICY,
  type LearningPolicy,
  findDuplicateLearning,
  newLearning,
  reinforceLearning,
} from '@holtkeeper/rules'
import type { Learning, Store } from '@holtkeeper/store'
import { z } from 'zod'

import { type ReviewComment, collectReviewComments } from './evidence.ts'
import { type MinerCall, mineRules } from './generate.ts'
import { MINER_VERSION } from './prompt.ts'

/** Actor of the audit events a run writes. */
export const MINER_ACTOR = 'agent:rule-miner'

/** Most learnings the first run on a repository creates. */
export const FIRST_RUN_LEARNINGS = 10
/** Most learnings every later run creates. */
export const RUN_LEARNINGS = 5
/** Days between two runs on one repository; `force` ignores it. */
export const MINE_INTERVAL_DAYS = 14
/** Most existing learnings the prompt lists. */
export const EXISTING_LEARNINGS = 40
/**
 * Most automatic runs that start on one UTC day (`Analyzer.dailyLimit`): with the per-call cap of
 * the main tier ($0.40) at most $4 a day.
 */
export const DAILY_RUNS = 10

const DAY = 24 * 3600 * 1000

/** What happened to one mined rule. */
export type MinedRuleOutcome = 'created' | 'duplicate' | 'skipped' | 'dropped'

/** One rule of a run, as its record shows it. */
export interface MinedRuleRecord {
  text: string
  outcome: MinedRuleOutcome
  /** The created learning, or the existing one a duplicate was merged into. */
  learningId?: string
  files?: string[]
  /** Comments that support it. */
  comments: number
  /** Distinct merge requests among them. */
  mergeRequests: number[]
  /** Sources a duplicate added to the existing learning. */
  added?: number
  why: string
}

/** What a `rule-miner` run did, stored as its analysis data. */
export interface RuleMinerData {
  outcome: 'mined' | 'skipped'
  /** Why the run was skipped. */
  reason?: string
  /** No earlier run mined this repository. */
  firstRun?: boolean
  window?: {
    since: string
    until: string
    mergeRequests: number
    discussions: number
    threads: number
    comments: number
  }
  rules: MinedRuleRecord[]
  call?: MinerCall
  version?: number
  /** The one-off extra prompt of the run. */
  prompt?: string
}

const dataSchema: z.ZodType<RuleMinerData> = z.object({
  outcome: z.enum(['mined', 'skipped']),
  reason: z.string().optional(),
  firstRun: z.boolean().optional(),
  window: z
    .object({
      since: z.string(),
      until: z.string(),
      mergeRequests: z.number(),
      discussions: z.number(),
      threads: z.number(),
      comments: z.number(),
    })
    .optional(),
  rules: z.array(
    z.object({
      text: z.string(),
      outcome: z.enum(['created', 'duplicate', 'skipped', 'dropped']),
      learningId: z.string().optional(),
      files: z.array(z.string()).optional(),
      comments: z.number(),
      mergeRequests: z.array(z.number()),
      added: z.number().optional(),
      why: z.string(),
    }),
  ),
  call: z
    .object({
      tier: z.enum(['main', 'deep']),
      model: z.string(),
      costUsd: z.number(),
      estimateUsd: z.number(),
    })
    .optional(),
  version: z.number().optional(),
  prompt: z.string().optional(),
})

const count = (data: RuleMinerData, outcome: MinedRuleOutcome) =>
  data.rules.filter((rule) => rule.outcome === outcome).length

const summarize = (data: RuleMinerData): Metric[] => [
  metric('created', 'Learnings created', count(data, 'created')),
  metric('merged', 'Merged into existing learnings', count(data, 'duplicate')),
  metric('comments', 'Review comments read', data.window?.comments ?? 0),
  metric('cost', 'Cost (USD)', Math.round((data.call?.costUsd ?? 0) * 10_000) / 10_000, {
    unit: 'text',
  }),
]

/** The `rule-miner` analysis kind: one record per mining run. */
export const ruleMinerAnalysis = defineAnalysis<RuleMinerData>({
  kind: 'rule-miner',
  label: 'Rule miner',
  schema: dataSchema,
  summarize,
  toReport(current): Report {
    const data = current.data
    return {
      kind: 'rule-miner',
      title: 'Rule miner',
      subtitle:
        data.outcome === 'skipped'
          ? `Skipped: ${data.reason ?? 'nothing to do'}`
          : data.call
            ? `${data.call.model}, $${data.call.costUsd.toFixed(4)} (estimated $${data.call.estimateUsd.toFixed(2)})`
            : 'Mined',
      subject: { repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) },
      generatedAt: current.createdAt,
      metrics: summarize(data),
      sections: [
        {
          id: 'rules',
          title: 'Learnings',
          description: [
            data.window
              ? `Merge requests merged since ${data.window.since.slice(0, 10)}: ${data.window.mergeRequests}; reviewer threads read: ${data.window.threads}, of which led to a change: ${data.window.comments}.`
              : '',
            'New learnings wait in the Inbox for the approval delay; duplicates reinforce the learning they repeat.',
            data.prompt ? `Extra prompt: ${data.prompt}` : '',
          ]
            .filter(Boolean)
            .join(' '),
          blocks: [
            {
              type: 'table',
              columns: [
                { key: 'text', label: 'Rule' },
                { key: 'outcome', label: 'Outcome' },
                { key: 'files', label: 'Files', format: 'code' },
                { key: 'comments', label: 'Comments' },
                { key: 'why', label: 'Why' },
              ],
              rows: data.rules.map((rule) => ({
                text: rule.text,
                outcome: rule.outcome,
                files: rule.files?.join(', ') ?? null,
                comments: rule.comments,
                why: rule.why,
              })),
            },
          ],
        },
      ],
    }
  },
})

const optionsSchema = z.object({
  /** How many months of merged merge requests the first run reads. */
  months: z.coerce.number().int().min(1).max(24).default(6),
  /** Most learnings a run creates, below the first-run and per-run caps. */
  maxLearnings: z.coerce
    .number()
    .int()
    .min(1)
    .max(FIRST_RUN_LEARNINGS)
    .default(FIRST_RUN_LEARNINGS),
  /** Most merged merge requests listed. */
  maxMergeRequests: z.coerce.number().int().min(0).max(200).default(80),
  /** Most merge requests whose review threads are read. */
  discussionMergeRequests: z.coerce.number().int().min(0).max(100).default(40),
  /** Comments that led to a change a run needs before it calls a model. */
  minComments: z.coerce.number().int().min(1).max(50).default(3),
  /** Model tier of the call. */
  tier: z.enum(['main', 'deep']).default('main'),
  /** Run even within `MINE_INTERVAL_DAYS` of the last run or with too few comments. */
  force: z.boolean().default(false),
  /** One-off extra prompt for this run; stored with its record. */
  prompt: z.string().trim().max(2_000).optional(),
})

export type RuleMinerOptions = z.output<typeof optionsSchema>

/** The value of a repository's `minerMarker`. */
export interface MinerMark {
  /** When a run last looked at the repository. */
  at: string
  jobId?: string
  /** Merge requests merged before this time were mined; the next run reads from here. */
  minedUntil?: string
  /** Runs that called a model. */
  runs: number
  /** Learnings all runs created. */
  created: number
}

const markSchema = z.object({
  at: z.string(),
  jobId: z.string().optional(),
  minedUntil: z.string().optional(),
  runs: z.number().default(0),
  created: z.number().default(0),
})

/** The `Store.kv` key of a repository's `MinerMark`: `rule-miner:<forge>:<path>`. */
export const minerMarker = (repo: RepoRef): string => `rule-miner:${repo.forge}:${repo.path}`

/** The repository's `MinerMark`, or `undefined` before its first run or when it is unreadable. */
export async function readMinerMark(
  store: Pick<Store, 'kv'>,
  repo: RepoRef,
): Promise<MinerMark | undefined> {
  const value = await store.kv?.get(minerMarker(repo))
  const parsed = markSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * The folder every path lies under, as a `folder/**` glob, or `undefined` when one is missing or
 * they share no folder.
 */
export function sourceFolderGlob(paths: readonly (string | undefined)[]): string | undefined {
  if (!paths.length || paths.some((path) => !path)) return undefined
  const folders = paths.map((path) => (path ?? '').split('/').slice(0, -1))
  const [first = [], ...rest] = folders
  let length = first.length
  for (const folder of rest) {
    let shared = 0
    while (shared < Math.min(length, folder.length) && folder[shared] === first[shared]) shared++
    length = shared
  }
  return length ? `${first.slice(0, length).join('/')}/**` : undefined
}

/** What the `rule-miner` analyzer needs from the server. */
export interface RuleMinerDeps {
  /** Learnings and the marker store; with `audit`, every write is audited. */
  store: Pick<Store, 'learnings' | 'kv'> & Partial<Pick<Store, 'audit'>>
  /** Holtkeeper's own account on the repository's forge. */
  botUsername?: (repo: RepoRef) => string | undefined
  /** Approval delay and expiry for learnings of the repository; default `DEFAULT_LEARNING_POLICY`. */
  policy?: (repo: RepoRef) => Promise<LearningPolicy>
  now?: () => Date
}

const keyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const alone = (repo: RepoRef) => ({ ...repo, teams: [] })

/** Whether `learning` names `repo` by its own scope, without teams. */
const coversRepo = (learning: Learning, repo: RepoRef) =>
  scopeCoversRepo(learning.scope, alone(repo))

/**
 * The `rule-miner` analyzer: learns short rules from what reviewers asked for. It reads the review
 * threads of merge requests merged since its last run (`collectReviewComments`: comments that led
 * to a change), makes one capped agent call (`mineRules`) and, best supported first, stores each
 * rule as a `pending` learning with `origin: 'miner'` (`newLearning` with the repository's
 * policy; never approved by itself), scoped to the repository and, when its comments all sit
 * under one folder, to `folder/**`, with every supporting comment as a source. A rule that
 * repeats an existing learning (`findDuplicateLearning`, rejected ones included) is not created:
 * its comments are merged into that learning as sources (`reinforceLearning`), and a learning
 * scoped to other repositories only gets this one added. The first run creates at most
 * `FIRST_RUN_LEARNINGS`, later runs `RUN_LEARNINGS` (both below `maxLearnings`); duplicates do not
 * count.
 *
 * At most one run per repository every `MINE_INTERVAL_DAYS` (`appliesTo` and `run` check the
 * `minerMarker`; `force` overrides), at most `DAILY_RUNS` automatic runs per UTC day. A run with
 * fewer than `minComments` comments calls no model and leaves the window where it was. Without an
 * agent or a forge the run is skipped unmarked; a `BudgetExceededError` propagates with nothing
 * stored. Without `deps` (catalogs) it cannot run.
 */
export function createRuleMinerAnalyzer(deps?: RuleMinerDeps) {
  const now = deps?.now ?? (() => new Date())
  return defineAnalyzer<RuleMinerData, RuleMinerOptions>({
    kind: 'rule-miner',
    analysis: ruleMinerAnalysis,
    scope: 'repo',
    needs: { checkout: true, forge: 'optional', agent: 'optional' },
    defaultBranchOnly: true,
    keepRecords: 10,
    dailyLimit: DAILY_RUNS,
    refresh: { on: 'change', minInterval: `${MINE_INTERVAL_DAYS}d` },
    options: optionsSchema,
    async appliesTo({ repo }) {
      if (!deps) return true
      const mark = await readMinerMark(deps.store, repo)
      return !mark || now().getTime() - Date.parse(mark.at) >= MINE_INTERVAL_DAYS * DAY
    },
    async run(context) {
      const { repo, dir, options, log } = context
      if (!deps) throw new Error('the rule-miner analyzer needs the server learning store')
      if (!dir) throw new Error('the rule-miner analyzer needs a checkout')
      if (context.ref !== undefined)
        throw new Error(
          'the rule-miner analyzer reads only the default branch; queue it without a ref',
        )
      const { store } = deps
      const step = context.step ?? (<T>(_: string, run: () => Promise<T>) => run())
      const head = await context.runner.run(['git', 'rev-parse', 'HEAD'], { cwd: dir })
      const sha = head.exitCode === 0 ? head.stdout.trim() || undefined : undefined
      const done = (data: RuleMinerData) => ({ data, ...(sha && { sha }) })
      const skipped = (reason: string) => {
        log?.(`skipped: ${reason}`)
        return done({ outcome: 'skipped', reason, rules: [] })
      }

      const started = now()
      const mark = await readMinerMark(store, repo)
      if (
        mark &&
        !options.force &&
        started.getTime() - Date.parse(mark.at) < MINE_INTERVAL_DAYS * DAY
      )
        return skipped(
          `mined ${mark.at.slice(0, 10)}; the next run is due ${MINE_INTERVAL_DAYS} days later (run with force to repeat)`,
        )
      if (!context.agent) return skipped('no AI agent is configured')
      if (!context.forge) return skipped('no forge client for the repository')
      const agent = context.agent
      const forge = context.forge
      const firstRun = !mark?.runs
      const since = new Date(started)
      since.setUTCMonth(since.getUTCMonth() - options.months)
      if (mark?.minedUntil && Date.parse(mark.minedUntil) > since.getTime())
        since.setTime(Date.parse(mark.minedUntil))
      const writeMark = (value: MinerMark) => store.kv?.set(minerMarker(repo), value)

      const bot = deps.botUsername?.(repo)
      const collected = await step('collect review comments', () =>
        collectReviewComments({
          forge,
          repo,
          since,
          maxMergeRequests: options.maxMergeRequests,
          discussionMergeRequests: options.discussionMergeRequests,
          ...(bot && { botUsername: bot }),
          ...(log && { log }),
          ...(context.signal && { signal: context.signal }),
        }),
      )
      const window = {
        since: since.toISOString(),
        until: started.toISOString(),
        mergeRequests: collected.mergeRequests.length,
        discussions: collected.discussions,
        threads: collected.threads,
        comments: collected.comments.length,
      }
      log?.(
        `evidence: ${window.mergeRequests} merged merge requests since ${window.since.slice(0, 10)}, ${window.threads} reviewer threads, ${window.comments} led to a change`,
      )
      if (collected.comments.length < options.minComments && !options.force) {
        await writeMark({
          runs: 0,
          created: 0,
          ...mark,
          at: started.toISOString(),
          ...(context.jobId && { jobId: context.jobId }),
        })
        const reason = `${collected.comments.length} review comments led to a change since ${window.since.slice(0, 10)}; waiting for ${options.minComments}`
        log?.(`skipped: ${reason}`)
        return done({ outcome: 'skipped', reason, firstRun, window, rules: [] })
      }

      const cap = Math.min(options.maxLearnings, firstRun ? FIRST_RUN_LEARNINGS : RUN_LEARNINGS)
      const all = await store.learnings.list()
      const existing = all
        .filter(
          (learning) =>
            coversRepo(learning, repo) &&
            (learning.status === 'active' || learning.status === 'pending'),
        )
        .slice(0, EXISTING_LEARNINGS)
        .map((learning) => learning.text)

      const mined = await step('mine', () =>
        mineRules({
          agent,
          dir,
          tier: options.tier,
          prompt: {
            repo: keyOf(repo),
            since: window.since.slice(0, 10),
            maxRules: cap,
            comments: collected.comments,
            existing,
            ...(options.prompt && { extra: options.prompt }),
          },
          ...(context.signal && { signal: context.signal }),
          ...(log && { log }),
        }),
      )
      log?.(
        `mined ${mined.rules.length} rules on ${mined.call.model} for $${mined.call.costUsd.toFixed(4)}`,
      )

      const policy = (await deps.policy?.(repo)) ?? DEFAULT_LEARNING_POLICY
      const records: MinedRuleRecord[] = mined.dropped.map((rule) => {
        log?.(`dropped "${rule.text}" — ${rule.reason}`)
        return {
          text: rule.text,
          outcome: 'dropped',
          comments: 0,
          mergeRequests: [],
          why: rule.reason,
        }
      })
      const known = [...all]
      const fresh = mined.rules.filter((rule) => !findDuplicateLearning(rule.text, all)).length
      const costEach = fresh
        ? Math.round((mined.call.costUsd / Math.min(fresh, cap)) * 1_000_000) / 1_000_000
        : 0
      let created = 0

      await step('store', async () => {
        for (const rule of mined.rules) {
          const at = now().toISOString()
          const base = {
            text: rule.text,
            comments: rule.comments.length,
            mergeRequests: [...new Set(rule.comments.map((comment) => comment.mergeRequest.id))],
          }
          const duplicate = findDuplicateLearning(rule.text, known)
          if (duplicate) {
            // oxlint-disable-next-line no-await-in-loop -- re-read right before each write
            const current = (await store.learnings.get(duplicate.id)) ?? duplicate
            const merged = mergeInto(current, rule.comments, repo, at)
            const added = merged.sources.length - current.sources.length
            if (merged !== current) {
              // oxlint-disable-next-line no-await-in-loop -- one write at a time keeps dedupe exact
              await store.learnings.put(merged)
              // oxlint-disable-next-line no-await-in-loop -- see above
              await audit('learning.reinforce', merged, at, { sources: added })
              replace(known, merged)
            }
            log?.(
              `duplicate of learn:${current.id.slice(0, 8)} "${current.text}" — ${added} sources added`,
            )
            records.push({
              ...base,
              outcome: 'duplicate',
              learningId: current.id,
              added,
              why: added
                ? 'repeats an existing learning; its comments were added as sources'
                : 'repeats an existing learning',
            })
            continue
          }
          if (created >= cap) {
            records.push({
              ...base,
              outcome: 'skipped',
              why: `over the limit of ${cap} new learnings`,
            })
            continue
          }
          const folder = sourceFolderGlob(rule.comments.map((comment) => comment.path))
          const [first, ...more] = rule.comments
          const learning = newLearning(
            {
              text: rule.text,
              ...(rule.reason && { reason: rule.reason }),
              scope: { repos: [keyOf(repo)] },
              ...(folder && { files: [folder] }),
              origin: 'miner',
              ...(first && { source: first.source }),
              model: mined.call.model,
              costUsd: costEach,
            },
            { id: crypto.randomUUID(), now: at, policy },
          )
          const stored: Learning = {
            ...learning,
            sources: [...learning.sources, ...more.map((comment) => comment.source)],
          }
          // oxlint-disable-next-line no-await-in-loop -- see above
          await store.learnings.put(stored)
          // oxlint-disable-next-line no-await-in-loop -- see above
          await audit('learning.create', stored, at, { origin: 'miner', status: stored.status })
          known.push(stored)
          created++
          log?.(
            `created learn:${stored.id.slice(0, 8)} ${folder ? `[${folder}] ` : ''}"${stored.text}" — ${base.comments} comments in ${base.mergeRequests.length} merge requests`,
          )
          records.push({
            ...base,
            outcome: 'created',
            learningId: stored.id,
            ...(folder && { files: [folder] }),
            why: `${base.comments} comments in ${base.mergeRequests.length} merge requests led to a change`,
          })
        }
      })

      await writeMark({
        at: started.toISOString(),
        ...(context.jobId && { jobId: context.jobId }),
        minedUntil: started.toISOString(),
        runs: (mark?.runs ?? 0) + 1,
        created: (mark?.created ?? 0) + created,
      })
      log?.(
        `created ${created} learnings, merged ${records.filter((rule) => rule.outcome === 'duplicate').length} into existing ones`,
      )

      return done({
        outcome: 'mined',
        firstRun,
        window,
        rules: records,
        call: mined.call,
        version: MINER_VERSION,
        ...(options.prompt && { prompt: options.prompt }),
      })

      async function audit(
        action: string,
        learning: Learning,
        at: string,
        details: Record<string, unknown>,
      ) {
        await store.audit?.append({
          at,
          actor: { id: MINER_ACTOR, name: MINER_ACTOR, provider: 'agent' },
          via: 'job',
          action,
          target: { type: 'learning', id: learning.id, repo: keyOf(repo) },
          outcome: 'ok',
          details: { ...details, ...(context.jobId && { jobId: context.jobId }) },
        })
      }
    },
  })
}

const replace = (list: Learning[], learning: Learning) => {
  const index = list.findIndex((item) => item.id === learning.id)
  if (index >= 0) list[index] = learning
  else list.push(learning)
}

/**
 * `learning` with every comment as a new source (`reinforceLearning`) and, when its scope is a
 * list of other repositories only, `repo` added to it. The same object when nothing changes.
 */
function mergeInto(
  learning: Learning,
  comments: readonly ReviewComment[],
  repo: RepoRef,
  at: string,
): Learning {
  let merged = learning
  for (const comment of comments) merged = reinforceLearning(merged, { source: comment.source }, at)
  const widen =
    merged !== learning &&
    !learning.scope.all &&
    !learning.scope.teams?.length &&
    !coversRepo(learning, repo)
  return widen
    ? { ...merged, scope: { ...merged.scope, repos: [...(merged.scope.repos ?? []), keyOf(repo)] } }
    : merged
}
