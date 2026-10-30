import type { AnalysisRecord, AnalysisStore, AuditRunStore } from '@holtkeeper/store'
import type { z } from 'zod'

import {
  type InputName,
  type RiskInputs,
  type RiskSource,
  bundleView,
  changelogView,
  depgraphView,
  qualityView,
} from './inputs.ts'

/** Where earlier results come from: the analyzer context's `history`. */
export interface RiskHistory {
  analyses: AnalysisStore
  auditRuns: AuditRunStore
}

const HISTORY = 50

type RepoRef = AnalysisRecord['repo']

type Read<T> = { source: RiskSource<T> } | { error: string }

function read<T>(schema: z.ZodType<T>, record: AnalysisRecord): Read<T> {
  const parsed = schema.safeParse(record.data)
  if (!parsed.success)
    return {
      error: `${record.kind} record ${record.id} is unreadable: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    }
  return {
    source: {
      id: record.id,
      kind: record.kind,
      ...(record.ref ? { ref: record.ref } : {}),
      createdAt: record.createdAt,
      data: parsed.data,
    },
  }
}

/**
 * The record for `ref` (or the newest one when `strict` is off and none matches) and the newest
 * older record with a different ref. Records come newest first.
 */
export function pickPair(
  records: AnalysisRecord[],
  ref: string | undefined,
  strict: boolean,
): [AnalysisRecord | undefined, AnalysisRecord | undefined] {
  const index = ref === undefined ? -1 : records.findIndex((record) => record.ref === ref)
  const at = index === -1 ? (strict ? -1 : 0) : index
  const current = at === -1 ? undefined : records[at]
  if (!current) return [undefined, undefined]
  const previous = records
    .slice(at + 1)
    .find((record) => record.ref === undefined || record.ref !== current.ref)
  return [current, previous]
}

/**
 * Loads everything `assessRisk` uses for one repository: the changelog of `ref` (the newest
 * changelog when `ref` is absent), the bundle of that ref and the one before it, and the latest two
 * quality, depgraph and audit results. Absent records stay absent; unreadable ones are reported.
 */
export async function loadRiskInputs(
  history: RiskHistory,
  repo: RepoRef,
  ref?: string,
): Promise<RiskInputs> {
  const list = (kind: string) => history.analyses.list({ repo, kind, limit: HISTORY })
  const [changelogs, bundles, qualities, graphs, runs] = await Promise.all([
    list('changelog'),
    list('bundle'),
    list('quality'),
    list('depgraph'),
    history.auditRuns.list({ repo, limit: 2 }),
  ])

  const inputs: RiskInputs = {}
  const unreadable: { input: InputName; reason: string }[] = []
  const assign = <T>(name: InputName, schema: z.ZodType<T>, record: AnalysisRecord | undefined) => {
    if (!record) return
    const result = read(schema, record)
    if ('error' in result) unreadable.push({ input: name, reason: result.error })
    else Object.assign(inputs, { [name]: result.source })
  }

  const changelog = ref === undefined ? changelogs[0] : changelogs.find((r) => r.ref === ref)
  assign('changelog', changelogView, changelog)
  const target = ref ?? inputs.changelog?.data.to.name ?? changelog?.ref
  if (target) inputs.ref = target

  const [bundle, previousBundle] = pickPair(bundles, target, true)
  assign('bundle', bundleView, bundle)
  assign('previousBundle', bundleView, previousBundle)
  const [quality, previousQuality] = pickPair(qualities, target, false)
  assign('quality', qualityView, quality)
  assign('previousQuality', qualityView, previousQuality)
  const [graph, previousGraph] = pickPair(graphs, target, false)
  assign('depgraph', depgraphView, graph)
  assign('previousDepgraph', depgraphView, previousGraph)

  const [audit, previousAudit] = runs
  if (audit)
    inputs.audit = { id: audit.id, kind: 'audit', createdAt: audit.finishedAt, data: audit.report }
  if (previousAudit)
    inputs.previousAudit = {
      id: previousAudit.id,
      kind: 'audit',
      createdAt: previousAudit.finishedAt,
      data: previousAudit.report,
    }

  if (unreadable.length > 0) inputs.unreadable = unreadable
  return inputs
}
