import { type RepoTarget, isSubgroup } from '@holtkeeper/access'
import { defineAnalyzer } from '@holtkeeper/analyzer'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import {
  KnowledgeValidationError,
  type Placement,
  type PlacementLevel,
  bootstrapMarker,
  describeScope,
  entriesInRoots,
  entryGroups,
  mergeEvidence,
  placeLessons,
  proposeEntry,
  reachesRepoRoots,
  scopeNamesRepo,
} from '@holtkeeper/knowledge'
import { listFiles } from '@holtkeeper/quality-tests'
import { type Metric, type Report, defineAnalysis, metric } from '@holtkeeper/report'
import type { KnowledgeEntry, Store } from '@holtkeeper/store'
import { z } from 'zod'

import { type BootstrapEvidence, collectCodeEvidence, directDependencies } from './evidence-code.ts'
import { type MergeRequestRef, collectMergeRequestEvidence } from './evidence-mr.ts'
import { type BootstrapCall, type EvidenceLinks, generateLessons } from './generate.ts'
import { BOOTSTRAP_VERSION, type ExistingEntryLine, type LibraryLine } from './prompt.ts'

/** Actor stored as the author of every entry a run proposes. */
export const BOOTSTRAP_ACTOR = 'agent:knowledge-bootstrap'

/** Most existing entries the prompt lists. */
export const EXISTING_ENTRIES = 30
/** Most fleet libraries the prompt lists. */
export const FLEET_LIBRARIES = 30

/**
 * Most automatic runs that start on one UTC day (`Analyzer.dailyLimit`): with the per-call cap of
 * the main tier ($0.40) at most $4 a day, about $1.20 at the usual estimate.
 */
export const DAILY_RUNS = 10

/** What happened to one lesson of a run. */
export type LessonOutcome = 'created' | 'duplicate' | 'covered' | 'dropped'

/** One lesson of a run, as its record and log show it. */
export interface LessonRecord {
  title: string
  level?: PlacementLevel
  /** `describeScope` of where it went. */
  scope?: string
  outcome: LessonOutcome
  entryId?: string
  duplicateOf?: string
  supersedes?: string
  why: string
}

/** What a `knowledge-bootstrap` run did, stored as its analysis data. */
export interface KnowledgeBootstrapData {
  outcome: 'proposed' | 'skipped'
  /** Why the run was skipped. */
  reason?: string
  window?: { since: string; mergeRequests: number; discussions: number }
  evidence: { id: string; label: string }[]
  lessons: LessonRecord[]
  call?: BootstrapCall
  version?: number
  /** The one-off extra prompt of the run. */
  prompt?: string
}

const levels = z.enum(['repo', 'subgroup', 'group', 'library'])

const dataSchema: z.ZodType<KnowledgeBootstrapData> = z.object({
  outcome: z.enum(['proposed', 'skipped']),
  reason: z.string().optional(),
  window: z
    .object({ since: z.string(), mergeRequests: z.number(), discussions: z.number() })
    .optional(),
  evidence: z.array(z.object({ id: z.string(), label: z.string() })),
  lessons: z.array(
    z.object({
      title: z.string(),
      level: levels.optional(),
      scope: z.string().optional(),
      outcome: z.enum(['created', 'duplicate', 'covered', 'dropped']),
      entryId: z.string().optional(),
      duplicateOf: z.string().optional(),
      supersedes: z.string().optional(),
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

const created = (data: KnowledgeBootstrapData) =>
  data.lessons.filter((lesson) => lesson.outcome === 'created')

const summarize = (data: KnowledgeBootstrapData): Metric[] => [
  metric('proposed', 'Entries proposed', created(data).length),
  metric(
    'promoted',
    'Proposed above the repository',
    created(data).filter((lesson) => lesson.level === 'subgroup' || lesson.level === 'group')
      .length,
  ),
  metric('cost', 'Cost (USD)', Math.round((data.call?.costUsd ?? 0) * 10_000) / 10_000, {
    unit: 'text',
  }),
]

/** The `knowledge-bootstrap` analysis kind: one record per starter knowledge run. */
export const knowledgeBootstrapAnalysis = defineAnalysis<KnowledgeBootstrapData>({
  kind: 'knowledge-bootstrap',
  label: 'Starter knowledge',
  schema: dataSchema,
  summarize,
  toReport(current): Report {
    const data = current.data
    return {
      kind: 'knowledge-bootstrap',
      title: 'Starter knowledge',
      subtitle:
        data.outcome === 'skipped'
          ? `Skipped: ${data.reason ?? 'nothing to do'}`
          : data.call
            ? `${data.call.model}, $${data.call.costUsd.toFixed(4)} (estimated $${data.call.estimateUsd.toFixed(2)})`
            : 'Proposed',
      subject: { repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) },
      generatedAt: current.createdAt,
      metrics: summarize(data),
      sections: [
        {
          id: 'lessons',
          title: 'Lessons',
          description: [
            data.window
              ? `Merge requests merged since ${data.window.since.slice(0, 10)}: ${data.window.mergeRequests}, discussions read: ${data.window.discussions}.`
              : '',
            'Every entry is a proposal in the Knowledge Inbox; promotions above the repository follow the scope agreement.',
            data.prompt ? `Extra prompt: ${data.prompt}` : '',
          ]
            .filter(Boolean)
            .join(' '),
          blocks: [
            {
              type: 'table',
              columns: [
                { key: 'title', label: 'Lesson' },
                { key: 'level', label: 'Level' },
                { key: 'scope', label: 'Scope', format: 'code' },
                { key: 'outcome', label: 'Outcome' },
                { key: 'why', label: 'Why' },
              ],
              rows: data.lessons.map((lesson) => ({
                title: lesson.title,
                level: lesson.level ?? null,
                scope: lesson.scope ?? null,
                outcome: lesson.outcome,
                why: lesson.why,
              })),
            },
          ],
        },
      ],
    }
  },
})

const optionsSchema = z.object({
  /** How many months of merged merge requests to read. */
  months: z.coerce.number().int().min(1).max(24).default(6),
  /** Most lessons proposed. */
  maxEntries: z.coerce.number().int().min(1).max(10).default(10),
  /** Place lessons a sibling repository shares at subgroup or group level. */
  promote: z.boolean().default(true),
  /** Most merged merge requests listed. */
  maxMergeRequests: z.coerce.number().int().min(0).max(200).default(60),
  /** Most merge requests whose review threads are read. */
  discussionMergeRequests: z.coerce.number().int().min(0).max(50).default(25),
  /** Model tier of the call. */
  tier: z.enum(['main', 'deep']).default('main'),
  /** Run even when the repository was bootstrapped already or has its own entries. */
  force: z.boolean().default(false),
  /** One-off extra prompt for this run; stored with its record. */
  prompt: z.string().trim().max(2_000).optional(),
})

export type KnowledgeBootstrapOptions = z.output<typeof optionsSchema>

/** A package a fleet repository owns, by subject (`Go:<module>`, `npm:<name>`). */
export interface FleetPackage {
  subject: string
  repo: RepoRef
}

/** The value of a repository's `bootstrapMarker`. */
export interface BootstrapMark {
  at: string
  jobId?: string
  proposed: number
  promoted: number
  /** `bootstrapped` after a run, `has-entries` when the repository already had entries. */
  reason: 'bootstrapped' | 'has-entries'
}

/** What the `knowledge-bootstrap` analyzer needs from the server. */
export interface KnowledgeBootstrapDeps {
  /** The knowledge base and the marker store; with `audit`, proposals are audited. */
  store?: Pick<Store, 'knowledge' | 'kv'> & Partial<Pick<Store, 'audit'>>
  /** Config groups of a repository, subgroups and roots. */
  groupsOf?: (repo: RepoRef) => string[]
  /** Holtkeeper's own account on the repository's forge. */
  botUsername?: (repo: RepoRef) => string | undefined
  /** Packages fleet repositories own, for library lessons. */
  fleetPackages?: () => Promise<FleetPackage[]>
  now?: () => Date
}

const keyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const markSchema = z.object({
  at: z.string(),
  jobId: z.string().optional(),
  proposed: z.number().default(0),
  promoted: z.number().default(0),
  reason: z.enum(['bootstrapped', 'has-entries']).default('bootstrapped'),
})

/**
 * Why the repository needs no starter knowledge, or `undefined` when it does: `marked` when a run
 * (or an earlier skip) left its `bootstrapMarker`, `has-entries` when a proposed or accepted entry
 * names it exactly (`forge:path` or the bare path; group, glob and `all` scopes do not count).
 * Library lessons other repositories' runs scoped to it (by `BOOTSTRAP_ACTOR`, with a `subject`)
 * do not count: they say how to use its library, not what its own code and merge requests teach.
 */
export async function bootstrapBlocker(
  store: Pick<Store, 'knowledge' | 'kv'>,
  repo: RepoRef,
): Promise<{ reason: 'marked'; mark: BootstrapMark } | { reason: 'has-entries' } | undefined> {
  const mark = await store.kv?.get(bootstrapMarker(repo))
  if (mark !== undefined && mark !== null) {
    const parsed = markSchema.safeParse(mark)
    return {
      reason: 'marked',
      mark: parsed.success
        ? parsed.data
        : { at: 'earlier', proposed: 0, promoted: 0, reason: 'bootstrapped' },
    }
  }
  const entries = await store.knowledge.list({ status: ['proposed', 'accepted'], scope: repo.path })
  return entries.some(
    (entry) =>
      scopeNamesRepo(entry.scope, repo) &&
      !(entry.author === BOOTSTRAP_ACTOR && entry.subject !== undefined),
  )
    ? { reason: 'has-entries' }
    : undefined
}

function existingLines(
  entries: readonly KnowledgeEntry[],
  target: RepoTarget,
  groupsOf: (repo: RepoRef) => string[],
): ExistingEntryLine[] {
  const own = new Set(target.groups.filter(isSubgroup))
  const rank = (entry: KnowledgeEntry) =>
    entryGroups(entry, groupsOf, target.forge).some((group) => own.has(group))
      ? 0
      : entry.scope.groups?.length
        ? 1
        : 2
  return entriesInRoots(entries, target, groupsOf)
    .toSorted(
      (a, b) =>
        rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    )
    .slice(0, EXISTING_ENTRIES)
    .map((entry) => ({
      id: entry.id,
      scope: describeScope(entry.scope),
      title: entry.title,
      body: entry.body,
    }))
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const short = (id: string) => `kb:${id.slice(0, 8)}`

function levelWords(placement: Placement & { action: 'create' }): string {
  const scope = placement.input.scope ?? {}
  if (placement.level === 'library')
    return `library ${placement.input.subject ?? ''} → ${(scope.repos ?? []).join(', ')}`
  if (placement.level === 'repo') return 'repo'
  return describeScope(scope)
}

async function repositoryLinks(
  forge: GitForge | undefined,
  repo: RepoRef,
  sha: string | undefined,
  mergeRequests: readonly MergeRequestRef[],
  log?: (line: string) => void,
): Promise<EvidenceLinks> {
  let webUrl: string | undefined
  if (forge)
    try {
      webUrl = (await forge.getRepository(repo.path)).webUrl || undefined
    } catch (error) {
      log?.(`repository links: ${message(error)}`)
    }
  return {
    ...(forge && { forgeKind: forge.kind }),
    ...(webUrl && { webUrl }),
    ...(sha && { sha }),
    mergeRequests,
  }
}

/**
 * The `knowledge-bootstrap` analyzer: builds starter knowledge for a repository the knowledge base
 * knows nothing about. It reads deterministic code evidence (`collectCodeEvidence`) and the merge
 * requests merged in the last `months` (`collectMergeRequestEvidence`), lists the team's existing
 * entries and the fleet libraries the repository uses, makes one capped agent call
 * (`generateLessons`) and places every lesson with the scope agreement (`placeLessons`): proposals
 * through `proposeEntry`, evidence for entries that already cover the repository through
 * `mergeEvidence`. Nothing it writes is accepted without review. Afterwards the repository gets
 * its `bootstrapMarker`, so it never runs on its own again.
 *
 * `appliesTo` (used by the new-repository trigger and schedules) is false for a repository that is
 * marked or has entries naming it (`bootstrapBlocker`). `run` checks again because manual runs
 * skip `appliesTo`; `force` runs anyway. A repository with entries is marked and skipped; without
 * an agent the run is skipped unmarked. A `BudgetExceededError` propagates, so the job ends
 * blocked with nothing stored and no marker. Without `deps.store` (outside the server) it cannot
 * run. Proposals count as duplicates only of entries of the repository's team or of the same
 * library subject. At most `DAILY_RUNS` automatic runs start per UTC day; the queue moves the rest
 * to later days.
 */
export function createKnowledgeBootstrapAnalyzer(deps: KnowledgeBootstrapDeps = {}) {
  const now = deps.now ?? (() => new Date())
  return defineAnalyzer<KnowledgeBootstrapData, KnowledgeBootstrapOptions>({
    kind: 'knowledge-bootstrap',
    analysis: knowledgeBootstrapAnalysis,
    scope: 'repo',
    needs: { checkout: true, forge: 'optional', agent: 'optional' },
    defaultBranchOnly: true,
    keepRecords: 10,
    dailyLimit: DAILY_RUNS,
    options: optionsSchema,
    async appliesTo({ repo }) {
      if (!deps.store) return true
      return (await bootstrapBlocker(deps.store, repo)) === undefined
    },
    async run(context) {
      const { repo, dir, options, log } = context
      const store = deps.store
      if (!store)
        throw new Error('the knowledge-bootstrap analyzer needs the server knowledge store')
      if (!dir) throw new Error('the knowledge-bootstrap analyzer needs a checkout')
      if (context.ref !== undefined)
        throw new Error(
          'the knowledge-bootstrap analyzer reads only the default branch; queue it without a ref',
        )
      const step = context.step ?? (<T>(_: string, run: () => Promise<T>) => run())
      const groupsOf = deps.groupsOf ?? (() => [])
      const target: RepoTarget = { ...repo, groups: groupsOf(repo) }
      const marker = bootstrapMarker(repo)
      const mark = (value: BootstrapMark) => store.kv?.set(marker, value)
      const skipped = (reason: string): { data: KnowledgeBootstrapData } => {
        log?.(`skipped: ${reason}`)
        return { data: { outcome: 'skipped', reason, evidence: [], lessons: [] } }
      }

      const blocker = await step('check', () => bootstrapBlocker(store, repo))
      if (blocker && !options.force) {
        if (blocker.reason === 'marked')
          return skipped(
            `already bootstrapped ${blocker.mark.at}${blocker.mark.jobId ? ` (job ${blocker.mark.jobId})` : ''}; run with force to repeat`,
          )
        await mark({
          at: now().toISOString(),
          ...(context.jobId && { jobId: context.jobId }),
          proposed: 0,
          promoted: 0,
          reason: 'has-entries',
        })
        return skipped('the repository already has knowledge entries of its own')
      }
      if (!context.agent) return skipped('no AI agent is configured')
      const agent = context.agent

      const head = await context.runner.run(['git', 'rev-parse', 'HEAD'], { cwd: dir })
      const sha = head.exitCode === 0 ? head.stdout.trim() || undefined : undefined
      const files = await listFiles(dir)
      const code = await step('collect code evidence', () => collectCodeEvidence(dir, files))
      const since = new Date(now())
      since.setUTCMonth(since.getUTCMonth() - options.months)
      const bot = deps.botUsername?.(repo)
      const mrs = await step('collect merge request evidence', async () => {
        if (!context.forge) {
          log?.('merge requests: no forge client; code evidence only')
          return { evidence: [], mergeRequests: [], discussions: 0, listed: false }
        }
        return collectMergeRequestEvidence({
          forge: context.forge,
          repo: repo.path,
          since,
          maxMergeRequests: options.maxMergeRequests,
          discussionMergeRequests: options.discussionMergeRequests,
          ...(bot && { botUsername: bot }),
          ...(log && { log }),
          ...(context.signal && { signal: context.signal }),
        })
      })
      log?.(
        `evidence: ${code.length} code items, ${mrs.mergeRequests.length} merged merge requests since ${since.toISOString().slice(0, 10)}, ${mrs.discussions} discussions read`,
      )
      const evidence: BootstrapEvidence[] = [...code, ...mrs.evidence]

      const { existing, libraries, dependencies, homes } = await step('read context', async () => {
        const entries = await store.knowledge.list({ status: ['proposed', 'accepted'] })
        const direct = await directDependencies(dir, files)
        let fleet: FleetPackage[] = []
        try {
          fleet = (await deps.fleetPackages?.()) ?? []
        } catch (error) {
          log?.(`fleet libraries: ${message(error)}`)
        }
        const homeOf = new Map<string, RepoRef>()
        for (const pkg of fleet) if (!homeOf.has(pkg.subject)) homeOf.set(pkg.subject, pkg.repo)
        const used: LibraryLine[] = [...homeOf]
          .filter(([subject, home]) => direct.has(subject) && keyOf(home) !== keyOf(repo))
          .toSorted(([a], [b]) => a.localeCompare(b))
          .slice(0, FLEET_LIBRARIES)
          .map(([subject, home]) => ({ subject, home: keyOf(home) }))
        return {
          existing: existingLines(entries, target, groupsOf),
          libraries: used,
          dependencies: [...direct].toSorted(),
          homes: homeOf,
        }
      })

      const links = await repositoryLinks(context.forge, repo, sha, mrs.mergeRequests, log)
      const generated = await step('generate', () =>
        generateLessons({
          agent,
          dir,
          tier: options.tier,
          links,
          prompt: {
            repo: keyOf(repo),
            groups: target.groups,
            since: since.toISOString().slice(0, 10),
            maxEntries: options.maxEntries,
            evidence,
            existing,
            libraries,
            dependencies,
            ...(options.prompt && { extra: options.prompt }),
          },
          ...(context.signal && { signal: context.signal }),
          ...(log && { log }),
        }),
      )
      log?.(
        `generated ${generated.lessons.length} lessons on ${generated.call.model} for $${generated.call.costUsd.toFixed(4)}`,
      )

      const lessons: LessonRecord[] = generated.dropped.map((lesson) => {
        log?.(`dropped "${lesson.title}" — ${lesson.reason}`)
        return { title: lesson.title, outcome: 'dropped', why: lesson.reason }
      })
      await step('propose', async () => {
        const placements = placeLessons({
          repo: target,
          lessons: generated.lessons,
          entries: await store.knowledge.list({ status: ['proposed', 'accepted', 'rejected'] }),
          groupsOf,
          libraryHome: (subject) => homes.get(subject),
          promote: options.promote,
        })
        for (const placement of placements) {
          if (placement.action === 'covered') {
            // oxlint-disable-next-line no-await-in-loop -- re-read right before each write
            const existingEntry = await store.knowledge.get(placement.entryId)
            if (!existingEntry) {
              lessons.push({
                title: placement.lesson.title,
                outcome: 'dropped',
                why: 'the covering entry is gone',
              })
              continue
            }
            // oxlint-disable-next-line no-await-in-loop -- see above
            const merged = await mergeEvidence({
              store,
              entry: existingEntry,
              evidence: placement.evidence,
              actor: BOOTSTRAP_ACTOR,
              repo: keyOf(repo),
              now,
            })
            const scope = describeScope(existingEntry.scope)
            log?.(
              `covered by ${short(existingEntry.id)} [${scope}] "${placement.lesson.title}" — evidence merged (${merged.added.length} new)`,
            )
            lessons.push({
              title: placement.lesson.title,
              scope,
              outcome: 'covered',
              entryId: existingEntry.id,
              why: placement.why,
            })
            continue
          }
          const where = levelWords(placement)
          try {
            const subject = placement.input.subject
            // oxlint-disable-next-line no-await-in-loop -- one proposal at a time keeps dedupe exact
            const result = await proposeEntry({
              store,
              input: { ...placement.input, appliesTo: ['*'] },
              actor: BOOTSTRAP_ACTOR,
              task: { repo: target },
              now,
              autoAccept: [],
              notDuplicates: placement.generalises ?? [],
              duplicateScope: (entry) =>
                reachesRepoRoots(entry, target, groupsOf) ||
                (subject !== undefined && entry.subject === subject),
            })
            const record: LessonRecord = {
              title: result.entry.title,
              level: placement.level,
              scope: describeScope(placement.input.scope ?? {}),
              outcome: result.created ? 'created' : 'duplicate',
              entryId: result.entry.id,
              ...(result.duplicateOf && { duplicateOf: result.duplicateOf }),
              ...(placement.supersedes && result.created && { supersedes: placement.supersedes }),
              why: placement.why,
            }
            lessons.push(record)
            log?.(
              result.created
                ? `proposed [${where}] "${result.entry.title}" — ${placement.why}`
                : `duplicate of ${short(result.entry.id)} "${result.entry.title}" — evidence merged`,
            )
          } catch (error) {
            if (!(error instanceof KnowledgeValidationError)) throw error
            log?.(`dropped "${placement.lesson.title}" — ${error.message}`)
            lessons.push({
              title: placement.lesson.title,
              level: placement.level,
              outcome: 'dropped',
              why: error.issues.join('; '),
            })
          }
        }
      })

      const proposedCount = lessons.filter((lesson) => lesson.outcome === 'created').length
      const promoted = lessons.filter(
        (lesson) =>
          lesson.outcome === 'created' && (lesson.level === 'subgroup' || lesson.level === 'group'),
      ).length
      await mark({
        at: now().toISOString(),
        ...(context.jobId && { jobId: context.jobId }),
        proposed: proposedCount,
        promoted,
        reason: 'bootstrapped',
      })
      log?.(
        `proposed ${proposedCount} entries, ${promoted} above the repository; marked as bootstrapped`,
      )

      const data: KnowledgeBootstrapData = {
        outcome: 'proposed',
        window: {
          since: since.toISOString(),
          mergeRequests: mrs.mergeRequests.length,
          discussions: mrs.discussions,
        },
        evidence: evidence.map(({ id, label }) => ({ id, label })),
        lessons,
        call: generated.call,
        version: BOOTSTRAP_VERSION,
        ...(options.prompt && { prompt: options.prompt }),
      }
      return { data, ...(sha && { sha }) }
    },
  })
}
