import { resolve } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import type { AnalyzerArtifact, AnalyzerContext, AnyAnalyzer } from '@holtkeeper/analyzer'
import { localRunner } from '@holtkeeper/exec'
import type { Report } from '@holtkeeper/report'
import { formatBytes } from '@holtkeeper/report'
import { z } from 'zod'

import { UsageError } from './audit.ts'

/** Usage lines for `analyze`, generated from the analyzers' flags. */
export const analyzeUsage = (analyzers: readonly AnyAnalyzer[]) =>
  analyzers
    .map((analyzer) => {
      const flags = (analyzer.flags ?? []).map(
        (f) => `      --${f.flag}${f.type === 'boolean' ? '' : ' <value>'}  ${f.description}`,
      )
      return [
        `  ${analyzer.kind} [dir]${analyzer.scope === 'group' ? '  (group: --group <name>)' : ''}`,
        ...flags,
      ].join('\n')
    })
    .join('\n')

/** Every analyzer flag as a `parseArgs` option, so one parser serves all analyzers. */
export const analyzerArgOptions = (analyzers: readonly AnyAnalyzer[]) =>
  Object.fromEntries(
    analyzers.flatMap((analyzer) =>
      (analyzer.flags ?? []).map((flag) => [flag.flag, { type: flag.type ?? 'string' }] as const),
    ),
  ) as Record<string, { type: 'string' | 'boolean' }>

export interface RunAnalyzerOptions {
  analyzer: AnyAnalyzer
  dir: string
  values: Record<string, unknown>
  agent?: Agent
  ref?: string
}

/** Runs an analyzer for the CLI: options from flags, the local directory as checkout. */
export async function runAnalyzer({ analyzer, dir, values, agent, ref }: RunAnalyzerOptions) {
  if (analyzer.scope === 'group')
    throw new UsageError(`${analyzer.kind} runs across a group; use the server's task engine`)
  if (analyzer.needs.agent === 'required' && !agent)
    throw new UsageError(`${analyzer.kind} needs an LLM: set ANTHROPIC_API_KEY`)
  if (analyzer.needs.forge || analyzer.needs.history) {
    throw new UsageError(
      `${analyzer.kind} needs forge access or history; run it through the server`,
    )
  }
  const raw = Object.fromEntries(
    (analyzer.flags ?? []).flatMap((flag) =>
      values[flag.flag] === undefined ? [] : [[flag.option, values[flag.flag]]],
    ),
  )
  const parsed = analyzer.options.safeParse(raw)
  if (!parsed.success) throw new UsageError(z.prettifyError(parsed.error))

  const checkout = resolve(dir)
  const context: AnalyzerContext<unknown> = {
    repo: { forge: 'local', path: checkout },
    dir: checkout,
    runner: localRunner,
    options: parsed.data,
    ...(agent ? { agent } : {}),
    ...(ref ? { ref } : {}),
    log: (line) => console.error(line),
  }
  return analyzer.run(context)
}

function formatValue(value: number | string, unit: string | undefined) {
  if (typeof value === 'string') return value
  return unit === 'bytes'
    ? formatBytes(value)
    : unit === 'percent'
      ? `${value.toFixed(1)}%`
      : String(value)
}

/** A compact plain-text view of a report: metrics, then section titles with their issues. */
export function formatReportText(report: Report): string {
  const lines = [report.title, ...(report.subtitle ? [report.subtitle] : []), '']
  for (const metric of report.metrics) {
    const delta =
      metric.delta === undefined || metric.delta === 0
        ? ''
        : ` (${metric.delta > 0 ? '+' : ''}${formatValue(metric.delta, metric.unit)})`
    lines.push(`  ${metric.label}: ${formatValue(metric.value, metric.unit)}${delta}`)
  }
  for (const section of report.sections) {
    lines.push('', `## ${section.title}`)
    for (const block of section.blocks) {
      if (block.type === 'issues')
        for (const issue of block.items) lines.push(`  [${issue.tone}] ${issue.title}`)
      if (block.type === 'timeline') for (const item of block.items) lines.push(`  - ${item.title}`)
      if (block.type === 'changes')
        for (const item of block.items) lines.push(`  * ${item.change.title}`)
    }
  }
  return lines.join('\n')
}

/**
 * Posts analysis data to a Holtkeeper server and returns the URL of the stored record. Run
 * artifacts go along base64-encoded; the server checks each against its SHA-256 id.
 */
export async function uploadAnalysis(
  server: string,
  repo: string,
  body: { kind: string; ref?: string; data: unknown; artifacts?: AnalyzerArtifact[] },
  fetcher: typeof fetch,
): Promise<string> {
  const separator = repo.indexOf(':')
  if (separator < 1) throw new UsageError('--repo must look like <forge>:<path>')
  const base = server.replace(/\/+$/, '')
  const response = await fetcher(`${base}/api/analyses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repo: { forge: repo.slice(0, separator), path: repo.slice(separator + 1) },
      kind: body.kind,
      ...(body.ref ? { ref: body.ref } : {}),
      data: body.data,
      ...(body.artifacts?.length
        ? {
            artifacts: body.artifacts.map((artifact) => ({
              id: artifact.id,
              base64: Buffer.from(artifact.data).toString('base64'),
              ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
              ...(artifact.name ? { name: artifact.name } : {}),
            })),
          }
        : {}),
    }),
  })
  const result: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message =
      typeof result === 'object' && result !== null && 'error' in result
        ? String(result.error)
        : response.statusText
    throw new UsageError(`upload failed (${response.status}): ${message}`)
  }
  const id =
    typeof result === 'object' && result !== null && 'id' in result ? String(result.id) : ''
  return `${base}/analyses/${id}`
}
