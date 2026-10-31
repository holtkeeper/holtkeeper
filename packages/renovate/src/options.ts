import type { AnalyzerPreset } from '@holtkeeper/analyzer'
import { z } from 'zod'

/**
 * - `report`: Renovate looks up updates and Holtkeeper reports them; nothing is pushed.
 * - `merge-requests`: Renovate opens and maintains its merge requests.
 */
export const renovateModeSchema = z.enum(['report', 'merge-requests'])

/**
 * - `separate`: one merge request per dependency, packages of one monorepo together.
 * - `non-major`: every minor and patch update in one merge request, majors on their own.
 * - `all`: every update in one merge request.
 */
export const renovateGroupingSchema = z.enum(['separate', 'non-major', 'all'])

/** Renovate's `rangeStrategy`: how declared ranges follow a new version. */
export const renovateRangeStrategySchema = z.enum([
  'auto',
  'bump',
  'replace',
  'widen',
  'pin',
  'update-lockfile',
])

/** Options of the `renovate` analyzer, the `analyzers.renovate` setting. */
export const renovateOptionsSchema = z.object({
  mode: renovateModeSchema.default('report').meta({
    title: 'Mode',
    description: 'Report available updates only, or let Renovate open merge requests.',
  }),
  updates: z.enum(['all', 'security']).default('all').meta({
    title: 'Updates',
    description: 'Every update, or only those that fix a known vulnerability.',
  }),
  majors: z.coerce.boolean().default(true).meta({
    title: 'Major versions',
    description: 'Propose major updates, which may break the build.',
  }),
  grouping: renovateGroupingSchema.default('separate').meta({
    title: 'Grouping',
    description: 'How updates are bundled into merge requests.',
  }),
  releaseAgeDays: z.coerce.number().int().min(0).max(90).default(3).meta({
    title: 'Release age',
    description: 'Days a release must be public before it is proposed; 0 proposes it at once.',
  }),
  vulnerabilityAlerts: z.coerce.boolean().default(true).meta({
    title: 'Security fixes',
    description: 'Look up advisories in OSV and propose fixes right away, ignoring release age.',
  }),
  lockFileMaintenance: z.coerce.boolean().default(false).meta({
    title: 'Lockfile maintenance',
    description: 'Refresh every lockfile once a week, also transitive dependencies.',
  }),
  rangeStrategy: renovateRangeStrategySchema.default('auto').meta({
    title: 'Range strategy',
    description: 'How declared ranges follow new versions; `auto` lets Renovate decide.',
  }),
  ignore: z.array(z.string().trim().min(1)).default([]).meta({
    title: 'Ignored dependencies',
    description: 'Names or globs Renovate never updates, e.g. `react` or `@internal/*`.',
  }),
  concurrentLimit: z.coerce.number().int().min(0).default(10).meta({
    title: 'Open merge requests',
    description: 'At most this many Renovate merge requests open at once; 0 is unlimited.',
  }),
  hourlyLimit: z.coerce.number().int().min(0).default(2).meta({
    title: 'New per hour',
    description: 'At most this many new merge requests per hour; 0 is unlimited.',
  }),
  draft: z.coerce.boolean().default(false).meta({
    title: 'Open as drafts',
    description: 'Open merge requests as drafts.',
  }),
  labels: z
    .array(z.string().trim().min(1))
    .default(['holtkeeper', 'dependencies'])
    .meta({ title: 'Labels', description: 'Labels of every Renovate merge request.' }),
  branchPrefix: z.string().trim().min(1).default('renovate/').meta({
    title: 'Branch prefix',
    description: 'Branches Renovate creates and owns start with this.',
  }),
  dependencyDashboard: z.coerce.boolean().default(false).meta({
    title: 'Dependency dashboard issue',
    description:
      'Keep Renovate’s dashboard issue in the repository; Holtkeeper’s report covers it.',
  }),
  repoConfig: z.enum(['merge', 'ignore']).default('merge').meta({
    title: 'Repository config',
    description: 'Apply a `renovate.json` found in the repository on top, or ignore it.',
  }),
  presets: z.array(z.string().trim().min(1)).default(['config:recommended']).meta({
    title: 'Renovate presets',
    description: 'Presets every repository extends, e.g. `config:recommended`.',
  }),
  config: z.record(z.string(), z.unknown()).default({}).meta({
    title: 'Raw Renovate config',
    description: 'Repository options merged last, for anything the fields above do not cover.',
  }),
  timeoutMinutes: z.coerce.number().positive().default(30).meta({
    title: 'Timeout',
    description: 'Minutes one Renovate run may take.',
  }),
})

export type RenovateMode = z.output<typeof renovateModeSchema>
export type RenovateGrouping = z.output<typeof renovateGroupingSchema>
export type RenovateOptions = z.output<typeof renovateOptionsSchema>

/** Ready-made setups the panel offers for `analyzers.renovate`. */
export const renovatePresets: AnalyzerPreset<RenovateOptions>[] = [
  {
    id: 'report',
    label: 'Report only',
    description: 'See what is outdated across repositories without any merge requests.',
    options: { mode: 'report' },
  },
  {
    id: 'calm',
    label: 'Calm',
    description:
      'Minor and patch updates together, a week of release age, few merge requests at a time.',
    options: {
      mode: 'merge-requests',
      updates: 'all',
      grouping: 'non-major',
      releaseAgeDays: 7,
      concurrentLimit: 5,
      hourlyLimit: 1,
      lockFileMaintenance: true,
    },
  },
  {
    id: 'fresh',
    label: 'Stay current',
    description: 'One merge request per dependency a day after release.',
    options: {
      mode: 'merge-requests',
      updates: 'all',
      grouping: 'separate',
      releaseAgeDays: 1,
      concurrentLimit: 20,
      hourlyLimit: 4,
    },
  },
  {
    id: 'security',
    label: 'Security fixes only',
    description: 'Merge requests only for dependencies with a known vulnerability.',
    options: { mode: 'merge-requests', updates: 'security', vulnerabilityAlerts: true },
  },
]
