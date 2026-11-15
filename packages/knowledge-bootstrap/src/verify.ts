import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { RepoTarget } from '@holtkeeper/access'
import { defineAnalyzer } from '@holtkeeper/analyzer'
import type { CommandRunner } from '@holtkeeper/exec'
import type { RepoRef } from '@holtkeeper/forge'
import {
  type FreshnessSignal,
  type KnowledgeFreshness,
  KnowledgeValidationError,
  evidenceCommits,
  evidencePaths,
  freshnessSignals,
  proposeEntry,
  readFreshness,
  scopeNamesRepo,
  writeFreshness,
} from '@holtkeeper/knowledge'
import { listFiles } from '@holtkeeper/quality-tests'
import { type Metric, type Report, defineAnalysis, metric } from '@holtkeeper/report'
import type { KnowledgeEntry, Store } from '@holtkeeper/store'
import { z } from 'zod'

import { directDependencies } from './evidence-code.ts'
import {
  VERIFY_CONTEXT,
  VERIFY_EVIDENCE_CHARS,
  VERIFY_SYSTEM,
  VERIFY_VERSION,
  type VerifyItem,
  verifyOutput,
  verifyPrompt,
} from './verify-prompt.ts'

/** Actor stored as the author of entries a verification proposes. */
export const VERIFY_ACTOR = 'agent:knowledge-verify'

/** Most entries a model judges per run; the rest wait for the next run. */
export const VERIFY_BATCH = 12

/** Spend cap of the call per tier, in USD. */
export const VERIFY_CAPS = { fast: 0.15, main: 0.4 } as const

/** What happened to one entry. */
export interface VerifyRecord {
  id: string
  title: string
  outcome: 'unchanged' | 'valid' | 'updated' | 'obsolete' | 'flagged' | 'deferred'
  reason?: string
  /** The entry proposed to replace this one. */
  proposal?: string
}

/** What a `knowledge-verify` run did, stored as its analysis data. */
export interface KnowledgeVerifyData {
  outcome: 'checked' | 'skipped'
  reason?: string
  records: VerifyRecord[]
  call?: { tier: string; model: string; costUsd: number }
  version?: number
}

const dataSchema: z.ZodType<KnowledgeVerifyData> = z.object({
  outcome: z.enum(['checked', 'skipped']),
  reason: z.string().optional(),
  records: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      outcome: z.enum(['unchanged', 'valid', 'updated', 'obsolete', 'flagged', 'deferred']),
      reason: z.string().optional(),
      proposal: z.string().optional(),
    }),
  ),
  call: z.object({ tier: z.string(), model: z.string(), costUsd: z.number() }).optional(),
  version: z.number().optional(),
})

const count = (data: KnowledgeVerifyData, outcome: VerifyRecord['outcome']) =>
  data.records.filter((record) => record.outcome === outcome).length

const summarize = (data: KnowledgeVerifyData): Metric[] => [
  metric('checked', 'Entries checked', data.records.length),
  metric('updated', 'Updates proposed', count(data, 'updated')),
  metric('obsolete', 'Found obsolete', count(data, 'obsolete')),
  metric('cost', 'Cost (USD)', Math.round((data.call?.costUsd ?? 0) * 10_000) / 10_000, {
    unit: 'text',
  }),
]

/** The `knowledge-verify` analysis kind: one record per freshness check of a repository. */
export const knowledgeVerifyAnalysis = defineAnalysis<KnowledgeVerifyData>({
  kind: 'knowledge-verify',
  label: 'Knowledge freshness',
  schema: dataSchema,
  summarize,
  toReport(current): Report {
    const data = current.data
    return {
      kind: 'knowledge-verify',
      title: 'Knowledge freshness',
      subtitle:
        data.outcome === 'skipped'
          ? `Skipped: ${data.reason ?? 'nothing to do'}`
          : data.call
            ? `${data.call.model}, $${data.call.costUsd.toFixed(4)}`
            : 'Checked without a model',
      subject: { repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) },
      generatedAt: current.createdAt,
      metrics: summarize(data),
      sections: [
        {
          id: 'entries',
          title: 'Entries',
          description:
            'Entries nothing changed for are confirmed without a model; flagged ones are judged once. Outdated entries get a replacement proposal in the Knowledge Inbox; nothing is archived on its own.',
          blocks: [
            {
              type: 'table',
              columns: [
                { key: 'title', label: 'Entry' },
                { key: 'outcome', label: 'Outcome' },
                { key: 'reason', label: 'Why' },
              ],
              rows: data.records
                .filter((record) => record.outcome !== 'unchanged')
                .map((record) => ({
                  title: record.title,
                  outcome: record.outcome,
                  reason: record.reason ?? null,
                })),
            },
          ],
        },
      ],
    }
  },
})

const optionsSchema = z.object({
  /** Model tier of the judging call. */
  tier: z.enum(['fast', 'main']).default('fast'),
  /** Judge every entry again, not only flagged ones. */
  force: z.boolean().default(false),
})

export type KnowledgeVerifyOptions = z.output<typeof optionsSchema>

/** What the `knowledge-verify` analyzer needs from the server. */
export interface KnowledgeVerifyDeps {
  store?: Pick<Store, 'knowledge' | 'kv'> & Partial<Pick<Store, 'audit'>>
  teamsOf?: (repo: RepoRef) => string[]
  now?: () => Date
}

const keyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

/**
 * The accepted entries a check of `repo` is responsible for: those that name the repository
 * exactly in their scope, and those whose evidence links point into it (a family or team entry
 * learned here). Broad entries with neither are left alone: no repository's code speaks for them.
 */
export const verifiableEntries = (
  entries: readonly KnowledgeEntry[],
  repo: RepoRef,
): KnowledgeEntry[] =>
  entries.filter(
    (entry) =>
      entry.status === 'accepted' &&
      (scopeNamesRepo(entry.scope, repo) || evidencePaths(entry, repo.path).length > 0),
  )

async function git(
  runner: CommandRunner,
  dir: string,
  args: string[],
): Promise<string | undefined> {
  const result = await runner.run(['git', ...args], { cwd: dir })
  return result.exitCode === 0 ? result.stdout : undefined
}

/** Diff of the changed anchor files (or the head of the existing ones), cut to the budget. */
async function evidenceFor(input: {
  runner: CommandRunner
  dir: string
  entry: KnowledgeEntry
  repoPath: string
  signals: readonly FreshnessSignal[]
  since: string | undefined
  files: ReadonlySet<string>
}): Promise<string> {
  const parts: string[] = []
  const changed = input.signals
    .filter((signal) => signal.kind === 'changed-file')
    .map((signal) => signal.detail.split(' ')[0] ?? '')
    .filter(Boolean)
  for (const path of changed) {
    if (!input.since) break
    // oxlint-disable-next-line no-await-in-loop -- a few small diffs, cut to the budget below
    const diff = await git(input.runner, input.dir, [
      'diff',
      '--unified=2',
      input.since,
      'HEAD',
      '--',
      path,
    ])
    if (diff) parts.push(`diff of ${path}:\n${diff}`)
  }
  if (!parts.length)
    for (const path of evidencePaths(input.entry, input.repoPath).filter((p) =>
      input.files.has(p),
    )) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      const text = await Bun.file(`${input.dir}/${path}`)
        .text()
        .catch(() => '')
      if (text) parts.push(`head of ${path}:\n${text.slice(0, 800)}`)
    }
  const missing = input.signals.filter((signal) => signal.kind === 'missing-file')
  for (const signal of missing) parts.push(`${signal.detail} no longer exists`)
  return parts.join('\n\n').slice(0, VERIFY_EVIDENCE_CHARS)
}

const describe = (signal: FreshnessSignal) => `${signal.kind}: ${signal.detail}`

/**
 * The `knowledge-verify` analyzer: checks, per repository, whether the accepted entries that rest
 * on its code still hold, so the knowledge base does not rot silently.
 *
 * 1. Deterministic filter (`freshnessSignals`): an evidence file is gone or changed since the last
 *    check, a `match.files` glob matches a changed file, a package the entry is about is no longer
 *    a dependency, or the last check is 90+ days old. Entries without a signal are marked `fresh`
 *    at the current commit for free.
 * 2. Flagged entries (at most `VERIFY_BATCH` per run, the most flagged first) go to one capped
 *    model call with their diff or file heads. The verdict is `valid` (fresh again), `update`
 *    (a replacement is proposed through `proposeEntry`, superseding the entry; it never
 *    replaces it by itself) or `obsolete` (marked `stale`).
 *
 * Nothing is archived or edited on its own. Results are kept per entry in `Store.kv`
 * (`readFreshness`). Without an agent flagged entries are marked `suspect` for people to look at.
 * It refreshes daily when the default branch moved; a `BudgetExceededError` propagates.
 */
export function createKnowledgeVerifyAnalyzer(deps: KnowledgeVerifyDeps = {}) {
  const now = deps.now ?? (() => new Date())
  return defineAnalyzer<KnowledgeVerifyData, KnowledgeVerifyOptions>({
    kind: 'knowledge-verify',
    analysis: knowledgeVerifyAnalysis,
    scope: 'repo',
    refresh: { on: 'change', minInterval: '1d' },
    needs: { checkout: true, forge: 'optional', agent: 'optional' },
    defaultBranchOnly: true,
    keepRecords: 10,
    options: optionsSchema,
    async run(context) {
      const { repo, dir, options, log } = context
      const store = deps.store
      if (!store) throw new Error('the knowledge-verify analyzer needs the server knowledge store')
      if (!store.kv) throw new Error('the knowledge-verify analyzer needs the key-value store')
      const kv = store.kv
      if (!dir) throw new Error('the knowledge-verify analyzer needs a checkout')
      if (context.ref !== undefined)
        throw new Error('the knowledge-verify analyzer reads only the default branch')
      const step = context.step ?? (<T>(_: string, run: () => Promise<T>) => run())
      const target: RepoTarget = { ...repo, teams: deps.teamsOf?.(repo) ?? [] }
      const repoKey = keyOf(repo)

      const head = await git(context.runner, dir, ['rev-parse', 'HEAD'])
      const sha = head?.trim() || undefined
      const withSha = <T extends object>(data: T) => ({ data, ...(sha && { sha }) })
      const entries = verifiableEntries(await store.knowledge.list({ status: 'accepted' }), repo)
      if (!entries.length) {
        log?.('skipped: no accepted entries rest on this repository')
        return withSha<KnowledgeVerifyData>({
          outcome: 'skipped',
          reason: 'no accepted entries rest on this repository',
          records: [],
        })
      }
      const at = now()
      const stored = await readFreshness(
        kv,
        entries.map((entry) => entry.id),
      )
      const listed = await listFiles(dir)
      const dependencies = await directDependencies(dir, listed)
      // `listFiles` skips dot folders and stops at a limit, so evidence paths are checked one by one:
      // a `.github/` file must not look deleted.
      const anchors = [...new Set(entries.flatMap((entry) => evidencePaths(entry, repo.path)))]
      const present = await Promise.all(
        anchors.map((path) =>
          stat(join(dir, path)).then(
            () => true,
            () => false,
          ),
        ),
      )
      const files = new Set(anchors.filter((_, index) => present[index]))

      // The commit each entry is compared from: its last check, else the commit its evidence was
      // linked at, so the first check already sees what changed since the entry was written.
      const baselineOf = (entry: KnowledgeEntry, previous: KnowledgeFreshness | undefined) =>
        previous?.sha ?? evidenceCommits(entry, repo.path).at(-1)
      const changedSince = new Map<string, Set<string> | undefined>()
      const baselines = new Set(entries.map((entry) => baselineOf(entry, stored.get(entry.id))))
      for (const previous of baselines) {
        if (!previous || previous === sha) continue
        // oxlint-disable-next-line no-await-in-loop -- a few distinct commits
        const out = await git(context.runner, dir, ['diff', '--name-only', previous, 'HEAD'])
        changedSince.set(
          previous,
          out === undefined ? undefined : new Set(out.split('\n').filter(Boolean)),
        )
      }

      const checked = entries.map((entry) => {
        const previous = stored.get(entry.id)
        const baseline = baselineOf(entry, previous)
        const changed =
          baseline === undefined
            ? undefined
            : baseline === sha
              ? new Set<string>()
              : changedSince.get(baseline)
        const judgedAt = previous ? (previous.judgedAt ?? previous.checkedAt) : undefined
        const signals = freshnessSignals({
          entry,
          repoPath: repo.path,
          state: { files, dependencies, now: at, ...(changed && { changed }) },
          ...(judgedAt && { judgedAt }),
        })
        return { entry, previous, signals }
      })

      const records: VerifyRecord[] = []
      const base = (signals: FreshnessSignal[], previous?: KnowledgeFreshness) => ({
        checkedAt: at.toISOString(),
        judgedAt: previous ? (previous.judgedAt ?? previous.checkedAt) : at.toISOString(),
        ...(sha && { sha }),
        repo: repoKey,
        signals,
      })
      const judged = (signals: FreshnessSignal[]) => ({
        ...base(signals),
        judgedAt: at.toISOString(),
      })
      const flagged = checked.filter(({ signals }) => options.force || signals.length > 0)
      const flaggedIds = new Set(flagged.map(({ entry }) => entry.id))
      for (const { entry, signals, previous } of checked) {
        if (flaggedIds.has(entry.id)) continue
        // A verdict stays until something new happens: nothing changed since an entry was found
        // stale or suspect does not make it fresh again. A fresh entry moves on to this commit.
        if (previous && (previous.status !== 'fresh' || previous.sha === sha)) {
          records.push({ id: entry.id, title: entry.title, outcome: 'unchanged' })
          continue
        }
        // oxlint-disable-next-line no-await-in-loop -- small writes
        await writeFreshness(kv, entry.id, {
          ...base(signals, previous),
          status: 'fresh',
          method: 'signals',
        })
        records.push({ id: entry.id, title: entry.title, outcome: 'unchanged' })
      }

      const batch = flagged
        .toSorted(
          (a, b) =>
            b.signals.length - a.signals.length ||
            (a.previous?.checkedAt ?? '').localeCompare(b.previous?.checkedAt ?? '') ||
            a.entry.id.localeCompare(b.entry.id),
        )
        .slice(0, VERIFY_BATCH)
      for (const { entry } of flagged.slice(VERIFY_BATCH))
        records.push({
          id: entry.id,
          title: entry.title,
          outcome: 'deferred',
          reason: 'over the batch limit',
        })
      log?.(`${entries.length} entries, ${flagged.length} flagged, ${batch.length} judged`)

      let call: KnowledgeVerifyData['call']
      const agent = context.agent
      if (!agent && batch.length) {
        for (const { entry, signals, previous } of batch) {
          // oxlint-disable-next-line no-await-in-loop -- small writes
          await writeFreshness(kv, entry.id, {
            ...base(signals, previous),
            status: 'suspect',
            method: 'signals',
            reason: 'flagged; no AI agent is configured to judge it',
          })
          records.push({
            id: entry.id,
            title: entry.title,
            outcome: 'flagged',
            reason: signals.map(describe).join('; '),
          })
        }
      } else if (agent && batch.length) {
        const items: VerifyItem[] = await step('collect evidence', () =>
          Promise.all(
            batch.map(async ({ entry, signals, previous }) => ({
              id: entry.id,
              title: entry.title,
              body: entry.body,
              signals: signals.map(describe),
              evidence: await evidenceFor({
                runner: context.runner,
                dir,
                entry,
                repoPath: repo.path,
                signals,
                since: previous?.sha,
                files,
              }),
            })),
          ),
        )
        const answer = await step('judge', () =>
          agent.run({
            dir,
            system: VERIFY_SYSTEM,
            context: VERIFY_CONTEXT,
            prompt: verifyPrompt(repoKey, items),
            capabilities: [],
            output: verifyOutput,
            maxTurns: 2,
            tier: options.tier,
            maxCostUsd: VERIFY_CAPS[options.tier],
            taskKind: 'knowledge-verify',
            ...(context.signal && { signal: context.signal }),
          }),
        )
        call = {
          tier: options.tier,
          model: answer.model ?? `tier:${options.tier}`,
          costUsd: answer.costUsd ?? 0,
        }
        const verdicts = new Map(
          (answer.output?.verdicts ?? []).map((verdict) => [verdict.id, verdict]),
        )
        for (const { entry, signals } of batch) {
          const verdict = verdicts.get(entry.id)
          const common = { ...judged(signals), method: 'model' as const }
          if (!verdict) {
            records.push({
              id: entry.id,
              title: entry.title,
              outcome: 'deferred',
              reason: 'the model gave no verdict',
            })
            continue
          }
          if (verdict.verdict === 'valid') {
            // oxlint-disable-next-line no-await-in-loop -- small writes
            await writeFreshness(kv, entry.id, {
              ...common,
              status: 'fresh',
              reason: verdict.reason,
            })
            records.push({
              id: entry.id,
              title: entry.title,
              outcome: 'valid',
              reason: verdict.reason,
            })
          } else if (verdict.verdict === 'obsolete') {
            // oxlint-disable-next-line no-await-in-loop -- see above
            await writeFreshness(kv, entry.id, {
              ...common,
              status: 'stale',
              reason: verdict.reason,
            })
            records.push({
              id: entry.id,
              title: entry.title,
              outcome: 'obsolete',
              reason: verdict.reason,
            })
          } else {
            let proposal: string | undefined
            if (verdict.title?.trim() && verdict.body?.trim())
              try {
                // oxlint-disable-next-line no-await-in-loop -- one proposal at a time keeps dedupe exact
                const result = await proposeEntry({
                  store,
                  input: {
                    title: verdict.title.trim(),
                    body: verdict.body.trim(),
                    kind: entry.kind,
                    topics: entry.topics,
                    appliesTo: entry.appliesTo,
                    scope: entry.scope,
                    ...(entry.match && { match: entry.match }),
                    ...(entry.packages && { packages: entry.packages }),
                    ...(entry.subject && { subject: entry.subject }),
                    visibility: entry.visibility,
                    evidence: entry.evidence,
                    supersedes: entry.id,
                  },
                  actor: VERIFY_ACTOR,
                  task: { repo: target },
                  now,
                  autoAccept: [],
                })
                proposal = result.created ? result.entry.id : result.duplicateOf
              } catch (error) {
                if (!(error instanceof KnowledgeValidationError)) throw error
                log?.(`update of ${entry.id} dropped: ${error.message}`)
              }
            // oxlint-disable-next-line no-await-in-loop -- see above
            await writeFreshness(kv, entry.id, {
              ...common,
              status: 'suspect',
              reason: verdict.reason,
              ...(proposal && { proposal }),
            })
            records.push({
              id: entry.id,
              title: entry.title,
              outcome: 'updated',
              reason: verdict.reason,
              ...(proposal && { proposal }),
            })
          }
        }
      }
      log?.(
        `fresh ${records.filter((r) => r.outcome === 'unchanged' || r.outcome === 'valid').length}, updates proposed ${records.filter((r) => r.outcome === 'updated').length}, obsolete ${records.filter((r) => r.outcome === 'obsolete').length}`,
      )
      return withSha<KnowledgeVerifyData>({
        outcome: 'checked',
        records,
        ...(call && { call }),
        version: VERIFY_VERSION,
      })
    },
  })
}
