import { z } from 'zod'

import {
  type AssetKind,
  type AssetsData,
  type KindTotal,
  type PolicyViolation,
  kindSchema,
  policyRules,
} from './data.ts'
import { wasted } from './findings.ts'

/** What is wrong with one file, or what would make it smaller. */
export interface AssetProblem {
  rule: (typeof assetProblemRules)[number]
  severity: 'error' | 'warning' | 'info'
  message: string
}

/** One file worth looking at: it breaks the policy, has a copy, or could be smaller. */
export interface AssetRow {
  path: string
  kind: AssetKind
  format: string
  bytes: number
  width?: number
  height?: number
  /** The worst severity of `problems`. */
  severity: AssetProblem['severity']
  problems: AssetProblem[]
  /** The best conversion or optimization found. */
  suggestion?: {
    format: string
    how: string
    expectedBytes: number
    saving: number
    method: 'estimate' | 'measured'
  }
}

/** Every `AssetProblem['rule']`: the policy rules, `duplicate` and `saving`. */
export const assetProblemRules = [...policyRules, 'duplicate', 'saving'] as const

const severitySchema = z.enum(['error', 'warning', 'info'])

/** Reads a stored `AssetRow`. */
export const assetRowSchema = z.object({
  path: z.string(),
  kind: kindSchema,
  format: z.string(),
  bytes: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  severity: severitySchema,
  problems: z.array(
    z.object({
      rule: z.enum(assetProblemRules),
      severity: severitySchema,
      message: z.string(),
    }),
  ),
  suggestion: z
    .object({
      format: z.string(),
      how: z.string(),
      expectedBytes: z.number(),
      saving: z.number(),
      method: z.enum(['estimate', 'measured']),
    })
    .optional(),
}) satisfies z.ZodType<AssetRow>

/** A short view of one assets analysis: totals, policy state and the files to act on. */
export interface AssetsSummary {
  files: number
  totalBytes: number
  totals: KindTotal[]
  errors: number
  warnings: number
  /** Budgets over every file or a kind that are exceeded. */
  budgets: PolicyViolation[]
  /** Bytes every suggestion together would save. */
  savings: number
  /** Bytes taken by extra copies of identical files. */
  duplicateBytes: number
  /** Offending or improvable files, errors first, then by size; at most `limit`. */
  rows: AssetRow[]
  /** Rows left out by `limit`. */
  more: number
}

const severityRank: Record<AssetProblem['severity'], number> = { error: 0, warning: 1, info: 2 }

const worst = (problems: readonly AssetProblem[]): AssetProblem['severity'] =>
  problems.reduce<AssetProblem['severity']>(
    (current, problem) =>
      severityRank[problem.severity] < severityRank[current] ? problem.severity : current,
    'info',
  )

/**
 * The summary of `data`: policy violations, duplicates and savings joined per file. Records made
 * before the policy existed have no violations and show only duplicates and savings.
 */
export function assetsSummary(data: AssetsData, limit = 200): AssetsSummary {
  const byPath = new Map(data.assets.map((asset) => [asset.path, asset]))
  const problems = new Map<string, AssetProblem[]>()
  const add = (path: string, problem: AssetProblem) =>
    problems.set(path, [...(problems.get(path) ?? []), problem])
  const violations = data.violations ?? []
  for (const violation of violations)
    if (violation.path)
      add(violation.path, {
        rule: violation.rule,
        severity: violation.severity,
        message: violation.message,
      })
  for (const duplicate of data.duplicates)
    for (const path of duplicate.paths.slice(1))
      add(path, {
        rule: 'duplicate',
        severity: 'info',
        message: `same content as ${duplicate.paths[0]}`,
      })
  const suggestions = new Map<string, AssetRow['suggestion'] & {}>()
  for (const suggestion of data.suggestions) {
    const current = suggestions.get(suggestion.path)
    if (current && current.saving >= suggestion.saving) continue
    suggestions.set(suggestion.path, {
      format: suggestion.suggested,
      how: suggestion.how,
      expectedBytes: suggestion.expectedBytes,
      saving: suggestion.saving,
      method: suggestion.method,
    })
  }
  for (const [path, suggestion] of suggestions)
    if (!problems.has(path))
      add(path, {
        rule: 'saving',
        severity: 'info',
        message: `${suggestion.format} saves ${Math.round((suggestion.saving / Math.max(1, suggestion.expectedBytes + suggestion.saving)) * 100)}%`,
      })
  const rows = [...problems].flatMap(([path, list]): AssetRow[] => {
    const asset = byPath.get(path)
    if (!asset) return []
    const size = asset.image ?? asset.video
    const suggestion = suggestions.get(path)
    return [
      {
        path,
        kind: asset.kind,
        format: asset.format,
        bytes: asset.bytes,
        ...(size?.width === undefined ? {} : { width: size.width }),
        ...(size?.height === undefined ? {} : { height: size.height }),
        severity: worst(list),
        problems: list.toSorted((a, b) => severityRank[a.severity] - severityRank[b.severity]),
        ...(suggestion ? { suggestion } : {}),
      },
    ]
  })
  const sorted = rows.toSorted(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      b.bytes - a.bytes ||
      a.path.localeCompare(b.path),
  )
  return {
    files: data.totals.reduce((sum, total) => sum + total.count, 0),
    totalBytes: data.totals.reduce((sum, total) => sum + total.bytes, 0),
    totals: data.totals,
    errors: violations.filter((violation) => violation.severity === 'error').length,
    warnings: violations.filter((violation) => violation.severity === 'warning').length,
    budgets: violations.filter((violation) => violation.rule === 'budget'),
    savings: [...suggestions.values()].reduce((sum, suggestion) => sum + suggestion.saving, 0),
    duplicateBytes: data.duplicates.reduce((sum, duplicate) => sum + wasted(duplicate), 0),
    rows: sorted.slice(0, limit),
    more: Math.max(0, sorted.length - limit),
  }
}
