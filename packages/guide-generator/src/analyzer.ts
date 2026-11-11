import type { RepoTarget } from '@holtkeeper/access'
import { defineAnalyzer } from '@holtkeeper/analyzer'
import { commitConventions } from '@holtkeeper/commit-conventions'
import { type CoverageData, coverageDataSchema } from '@holtkeeper/coverage'
import type { RepoRef } from '@holtkeeper/forge'
import { familyOf, repoKey, scopesFor } from '@holtkeeper/guide'
import { listFiles } from '@holtkeeper/quality-tests'
import { type Metric, type Report, defineAnalysis, metric } from '@holtkeeper/report'
import type {
  AnalysisStore,
  GuideScopeKey,
  GuideSection,
  GuideSectionName,
  Store,
} from '@holtkeeper/store'
import { type TestIdsData, testIdsDataSchema } from '@holtkeeper/testids'
import { z } from 'zod'

import { collectGeneral, collectTestIds, collectTesting, commitsText } from './evidence.ts'
import {
  type SectionInput,
  type SectionOutcome,
  generateGuide,
  placeGenerated,
} from './generate.ts'
import { type GeneratedSection, generatedSections } from './prompt.ts'

/** What a `guide` run did, stored as its analysis data. */
export interface GuideRunData {
  sections: {
    section: GeneratedSection
    outcome: SectionOutcome
    inputHash?: string
    reason?: string
    evidence: { id: string; label: string }[]
  }[]
  call?: { tier: string; model: string; costUsd: number; sections: string[] }
  /** The one-off extra prompt of the run. */
  prompt?: string
}

const sectionEnum = z.enum(generatedSections)

const guideRunDataSchema: z.ZodType<GuideRunData> = z.object({
  sections: z.array(
    z.object({
      section: sectionEnum,
      outcome: z.enum(['proposed', 'kept', 'unchanged', 'skipped']),
      inputHash: z.string().optional(),
      reason: z.string().optional(),
      evidence: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  ),
  call: z
    .object({
      tier: z.string(),
      model: z.string(),
      costUsd: z.number(),
      sections: z.array(z.string()),
    })
    .optional(),
  prompt: z.string().optional(),
})

const summarize = (data: GuideRunData): Metric[] => [
  metric(
    'proposed',
    'Sections proposed',
    data.sections.filter((section) => section.outcome === 'proposed').length,
  ),
  metric(
    'unchanged',
    'Sections unchanged',
    data.sections.filter((section) => section.outcome === 'unchanged').length,
  ),
  metric('cost', 'Cost (USD)', Math.round((data.call?.costUsd ?? 0) * 10_000) / 10_000, {
    unit: 'text',
  }),
]

/** The `guide` analysis kind: one record per generator run, saying what each section got. */
export const guideAnalysis = defineAnalysis<GuideRunData>({
  kind: 'guide',
  label: 'Guide generator',
  schema: guideRunDataSchema,
  summarize,
  toReport(current): Report {
    const data = current.data
    return {
      kind: 'guide',
      title: 'Guide generator',
      ...(data.call && {
        subtitle: `${data.call.model}, $${data.call.costUsd.toFixed(4)}`,
      }),
      subject: { repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) },
      generatedAt: current.createdAt,
      metrics: summarize(data),
      sections: [
        {
          id: 'sections',
          title: 'Sections',
          ...(data.prompt && { description: `Extra prompt: ${data.prompt}` }),
          blocks: [
            {
              type: 'table',
              columns: [
                { key: 'section', label: 'Section', format: 'code' },
                { key: 'outcome', label: 'Outcome' },
                { key: 'evidence', label: 'Evidence', format: 'tags' },
                { key: 'reason', label: 'Note' },
              ],
              rows: data.sections.map((section) => ({
                section: section.section,
                outcome: section.outcome,
                evidence: section.evidence.map((item) => item.id).join(', '),
                reason: section.reason ?? null,
              })),
            },
          ],
        },
      ],
    }
  },
})

const optionsSchema = z.object({
  /** Sections to consider; default all generated ones. */
  sections: z.array(sectionEnum).min(1).optional(),
  /** One-off extra prompt for this run; stored with what it writes. */
  prompt: z.string().trim().max(2_000).optional(),
  /** Regenerate even when the hashes did not change. */
  force: z.boolean().default(false),
})

export type GuideGeneratorOptions = z.output<typeof optionsSchema>

/** What the `guide` analyzer needs from the server. */
export interface GuideAnalyzerDeps {
  store?: Pick<Store, 'guides' | 'families'>
  /** Config groups of a repository, for the team scopes whose steering and rules apply. */
  groupsOf?: (repo: RepoRef) => string[]
}

async function latestData<T>(
  analyses: AnalysisStore | undefined,
  repo: RepoRef,
  kind: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  if (!analyses) return undefined
  const [record] = await analyses.latest({ repo, kind })
  const parsed = schema.safeParse(record?.data)
  return parsed.success ? parsed.data : undefined
}

const joined = (rows: readonly (GuideSection | undefined)[], field: 'steering' | 'rules') =>
  rows
    .map((row) => row?.[field].trim() ?? '')
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 1_500)

const emptyRow = (scope: GuideScopeKey, section: GuideSectionName): GuideSection => ({
  scope,
  section,
  rules: '',
  steering: '',
  version: 0,
  learnings: [],
})

/**
 * The `guide` analyzer: writes the generated layer of the `general`, `testing`, `testids` and
 * `commits` sections of a repository's Guide from deterministic evidence (see `generateGuide`).
 * New text is stored as a proposal a person accepts; accepted text stays what agents see until
 * then. Steering and team rules come from every scope of the repository. Runs after `coverage`
 * and `testids` so their newest records are read. Without `deps.store` (outside the server) it
 * cannot run.
 */
export function createGuideAnalyzer(deps: GuideAnalyzerDeps = {}) {
  return defineAnalyzer({
    kind: 'guide',
    analysis: guideAnalysis,
    scope: 'repo',
    refresh: { on: 'change', minInterval: '7d' },
    needs: { checkout: true, forge: 'optional', agent: 'optional', history: 'optional' },
    after: ['coverage', 'testids'],
    defaultBranchOnly: true,
    options: optionsSchema,
    async run(context) {
      const { repo, dir, options } = context
      const store = deps.store
      if (!store) throw new Error('the guide analyzer needs the server Guide store')
      if (!dir) throw new Error('the guide analyzer needs a checkout')
      if (context.ref !== undefined)
        throw new Error('the guide analyzer reads only the default branch; queue it without a ref')
      const step = context.step ?? (<T>(_: string, run: () => Promise<T>) => run())
      const target: RepoTarget = { ...repo, groups: deps.groupsOf?.(repo) ?? [] }
      const family = familyOf(await store.families.list(), repoKey(repo))
      const scopes = scopesFor(target, family?.id)
      const repoScope = scopes[0] ?? `repo:${repoKey(repo)}`
      const wanted = options.sections ?? [...generatedSections]
      const rows = await store.guides.list({ scopes, sections: wanted })
      const rowsOf = (section: GuideSectionName) =>
        scopes.map((scope) => rows.find((row) => row.scope === scope && row.section === section))

      const head = await context.runner.run(['git', 'rev-parse', 'HEAD'], { cwd: dir })
      const sha = head.exitCode === 0 ? head.stdout.trim() || undefined : undefined
      const inputs = await step('collect evidence', async () => {
        const files = await listFiles(dir)
        const collected: SectionInput[] = []
        for (const section of wanted) {
          const scoped = rowsOf(section)
          const common = {
            section,
            steering: joined(scoped, 'steering'),
            rules: joined(scoped, 'rules'),
            ...(scoped[0] && { stored: scoped[0] }),
          }
          if (section === 'general')
            // oxlint-disable-next-line no-await-in-loop -- sections are collected one by one
            collected.push({ ...common, evidence: await collectGeneral(dir, files) })
          else if (section === 'testing') {
            // oxlint-disable-next-line no-await-in-loop -- see above
            const coverage = await latestData<CoverageData>(
              context.history?.analyses,
              repo,
              'coverage',
              coverageDataSchema,
            )
            // oxlint-disable-next-line no-await-in-loop -- see above
            collected.push({ ...common, evidence: await collectTesting(dir, files, coverage) })
          } else if (section === 'testids') {
            // oxlint-disable-next-line no-await-in-loop -- see above
            const catalog = await latestData<TestIdsData>(
              context.history?.analyses,
              repo,
              'testids',
              testIdsDataSchema,
            )
            collected.push({ ...common, evidence: collectTestIds(catalog) })
          } else {
            // oxlint-disable-next-line no-await-in-loop -- see above
            const text = await commitSection(context.forge, repo, context.log)
            collected.push({
              ...common,
              evidence: text ? [{ id: 'conventions', label: 'Commit conventions', text }] : [],
              ...(text && { text }),
            })
          }
        }
        return collected
      })

      const result = await step('generate', () =>
        generateGuide({
          sections: inputs,
          ...(context.agent && { agent: context.agent }),
          dir,
          ...(options.prompt && { prompt: options.prompt }),
          force: options.force,
          ...(sha && { sha }),
          now: () => new Date(),
          ...(context.signal && { signal: context.signal }),
          ...(context.log && { log: context.log }),
        }),
      )

      for (const section of result.sections) {
        if (!section.layer) continue
        // oxlint-disable-next-line no-await-in-loop -- re-read right before each write
        const fresh = await store.guides.get(repoScope, section.section)
        const { proposal: _, ...row } = fresh ?? emptyRow(repoScope, section.section)
        const placed = placeGenerated(fresh, section.layer)
        // oxlint-disable-next-line no-await-in-loop -- see above
        await store.guides.put({
          ...row,
          generated: placed.generated,
          ...(placed.proposal && { proposal: placed.proposal }),
        })
        context.log?.(`${section.section}: ${placed.outcome}`)
      }

      const data: GuideRunData = {
        sections: result.sections.map((section) => ({
          section: section.section,
          outcome: section.outcome,
          ...(section.inputHash && { inputHash: section.inputHash }),
          ...(section.reason && { reason: section.reason }),
          evidence: section.evidence,
        })),
        ...(result.call && { call: result.call }),
        ...(options.prompt && { prompt: options.prompt }),
      }
      return { data, ...(sha && { sha }) }
    },
  })
}

async function commitSection(
  forge: Parameters<typeof commitConventions>[0]['forge'] | undefined,
  repo: RepoRef,
  log?: (line: string) => void,
): Promise<string | undefined> {
  if (!forge) return undefined
  try {
    return commitsText(await commitConventions({ forge, repo: repo.path })) || undefined
  } catch (error) {
    log?.(`commit conventions: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
