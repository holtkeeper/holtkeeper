import type { Tone } from '@holtkeeper/report'
import { z } from 'zod'

import type { InputName } from './inputs.ts'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

/** Ids of the factors an assessment is built from. */
export type FactorId =
  | 'size'
  | 'breaking'
  | 'bundle'
  | 'vulnerabilities'
  | 'untested'
  | 'dependencies'
  | 'quality'
  | 'contributors'

/** A link backing a factor: an underlying analysis, a commit, an advisory. */
export interface Evidence {
  label: string
  /** Relative (`/analyses/<id>`) for Holtkeeper pages, absolute for external ones. */
  href?: string
}

/** One explainable part of the score. */
export interface RiskFactor {
  id: FactorId
  label: string
  /** Contribution to the score, `0..max`, rounded to whole points. */
  points: number
  /** Most points the factor can contribute (its weight). */
  max: number
  /** Plain-language reason for the points, e.g. `3 new high vulnerabilities`. */
  detail: string
  tone: Tone
  /** Whether the inputs the factor needs were there; unknown factors score 0. */
  known: boolean
  evidence: Evidence[]
}

/** Something QA should look at, derived from changed areas. */
export interface TestArea {
  /** Scope, commit type or file the area stands for. */
  area: string
  /** Why it needs testing: change titles, or `changed without tests`. */
  reasons: string[]
  tone: Tone
  commits: number
}

/** A record an assessment was built from, for linking back. */
export interface SourceRef {
  id: string
  kind: string
  ref?: string
  createdAt: string
  /** Relative link to the record's page. */
  href: string
}

/** The release summary for QA and managers. */
export interface RiskSummary {
  /** `agent` when an LLM wrote it, `changelog` when it was built from changelog groups. */
  source: 'agent' | 'changelog'
  /** Agent name, when an agent wrote it. */
  agent?: string
  markdown: string
}

/** Stored result of the `release-risk` analysis. */
export interface ReleaseRiskData {
  ref?: string
  /** `0..100`; the sum of factor points, capped at 100. */
  score: number
  level: RiskLevel
  /** `0..1`: share of the inputs that were available. */
  confidence: number
  factors: RiskFactor[]
  /** Inputs that were absent or unreadable, with why. */
  missing: { input: InputName; reason: string }[]
  testAreas: TestArea[]
  summary: RiskSummary
  sources: SourceRef[]
}

const tone = z.enum(['neutral', 'info', 'good', 'warning', 'bad'])
const inputName = z.enum([
  'changelog',
  'bundle',
  'previousBundle',
  'quality',
  'previousQuality',
  'depgraph',
  'previousDepgraph',
  'audit',
  'previousAudit',
])

/** Validates `ReleaseRiskData`, e.g. uploads from CI. */
export const releaseRiskDataSchema: z.ZodType<ReleaseRiskData> = z.object({
  ref: z.string().optional(),
  score: z.number().min(0).max(100),
  level: z.enum(['low', 'medium', 'high', 'critical']),
  confidence: z.number().min(0).max(1),
  factors: z.array(
    z.object({
      id: z.enum([
        'size',
        'breaking',
        'bundle',
        'vulnerabilities',
        'untested',
        'dependencies',
        'quality',
        'contributors',
      ]),
      label: z.string(),
      points: z.number().nonnegative(),
      max: z.number().nonnegative(),
      detail: z.string(),
      tone,
      known: z.boolean(),
      evidence: z.array(z.object({ label: z.string(), href: z.string().optional() })),
    }),
  ),
  missing: z.array(z.object({ input: inputName, reason: z.string() })),
  testAreas: z.array(
    z.object({
      area: z.string(),
      reasons: z.array(z.string()),
      tone,
      commits: z.number().int().nonnegative(),
    }),
  ),
  summary: z.object({
    source: z.enum(['agent', 'changelog']),
    agent: z.string().optional(),
    markdown: z.string(),
  }),
  sources: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      ref: z.string().optional(),
      createdAt: z.string(),
      href: z.string(),
    }),
  ),
})
