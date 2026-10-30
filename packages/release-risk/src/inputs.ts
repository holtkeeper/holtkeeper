import type { AuditReport } from '@holtkeeper/vuln'
import { z } from 'zod'

const diffStat = z.object({ files: z.number(), insertions: z.number(), deletions: z.number() })

/**
 * The part of `changelog` data release risk reads. Unknown fields are dropped, so the view keeps
 * working as the changelog format grows. `files` is read when a changelog lists changed paths.
 */
export const changelogView = z.object({
  from: z.object({ name: z.string() }).optional(),
  to: z.object({ name: z.string() }),
  commits: z.array(
    z.object({
      sha: z.string(),
      parents: z.array(z.string()).default([]),
      author: z.object({ name: z.string() }),
      subject: z.string(),
      stats: diffStat.optional(),
      parsed: z.object({
        type: z.string().optional(),
        scope: z.string().optional(),
        breaking: z.boolean().default(false),
        breakingNote: z.string().optional(),
        description: z.string().default(''),
        merge: z.boolean().default(false),
        revert: z.object({ subject: z.string().optional() }).optional(),
        wip: z.boolean().default(false),
      }),
    }),
  ),
  diff: diffStat.optional(),
  files: z.array(z.string()).optional(),
  links: z.object({ commit: z.string() }).optional(),
})
export type ChangelogView = z.infer<typeof changelogView>
export type ChangelogViewCommit = ChangelogView['commits'][number]

/** The part of `bundle` data release risk reads. */
export const bundleView = z.object({
  assets: z.array(z.object({ name: z.string(), kind: z.string(), gzip: z.number() })),
  packages: z.array(z.object({ name: z.string(), gzip: z.number() })).default([]),
})
export type BundleView = z.infer<typeof bundleView>

const counts = z.object({ covered: z.number(), total: z.number() })

/** The part of `quality` data release risk reads. */
export const qualityView = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['error', 'warning', 'info']),
      message: z.string(),
      rule: z.string().default(''),
      file: z.string().optional(),
      url: z.string().optional(),
    }),
  ),
  tests: z
    .array(
      z.object({
        file: z.string(),
        symbol: z.string(),
        reason: z.string().default(''),
        coverage: counts.optional(),
      }),
    )
    .default([]),
  coverage: z.object({ lines: counts.optional() }).optional(),
})
export type QualityView = z.infer<typeof qualityView>

/** The part of `depgraph` data release risk reads. */
export const depgraphView = z.object({
  layers: z.array(
    z.object({
      id: z.string(),
      cycles: z.array(z.object({ members: z.array(z.string()), path: z.array(z.string()) })),
      duplicates: z.array(
        z.object({
          ecosystem: z.string(),
          name: z.string(),
          versions: z.array(z.object({ version: z.string() })),
        }),
      ),
    }),
  ),
})
export type DepgraphView = z.infer<typeof depgraphView>

/** One earlier result release risk builds on, with what is needed to link back to it. */
export interface RiskSource<Data> {
  /** Analysis record id, or audit run id for audits. */
  id: string
  /** `changelog`, `bundle`, `quality`, `depgraph` or `audit`. */
  kind: string
  ref?: string
  createdAt: string
  data: Data
}

/** Names of the inputs an assessment can use. */
export type InputName =
  | 'changelog'
  | 'bundle'
  | 'previousBundle'
  | 'quality'
  | 'previousQuality'
  | 'depgraph'
  | 'previousDepgraph'
  | 'audit'
  | 'previousAudit'

/**
 * Everything `assessRisk` looks at. Every input is optional: a missing one lowers the
 * assessment's confidence instead of failing it.
 */
export interface RiskInputs {
  /** Release being assessed; defaults to the changelog's `to`. */
  ref?: string
  /** Changelog of the release. */
  changelog?: RiskSource<ChangelogView>
  /** Bundle of the release and of the release before it. */
  bundle?: RiskSource<BundleView>
  previousBundle?: RiskSource<BundleView>
  /** Latest quality analysis and the one before it. */
  quality?: RiskSource<QualityView>
  previousQuality?: RiskSource<QualityView>
  /** Latest dependency graph and the one before it. */
  depgraph?: RiskSource<DepgraphView>
  previousDepgraph?: RiskSource<DepgraphView>
  /** Latest audit run and the one before it. Findings are already filtered by the allowlist. */
  audit?: RiskSource<AuditReport>
  previousAudit?: RiskSource<AuditReport>
  /** Inputs that exist but could not be read, with why. */
  unreadable?: { input: InputName; reason: string }[]
}
