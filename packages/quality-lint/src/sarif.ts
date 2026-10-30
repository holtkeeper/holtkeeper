import { fileURLToPath } from 'node:url'

import type { CodeChange, Edit, Range } from '@holtkeeper/changes'
import { type IssueSeverity, type QualityIssue, stableId } from '@holtkeeper/quality'
import type { ArtifactLocation, Fix, Log, Region, ReportingDescriptor, Result, Run } from 'sarif'
import { z } from 'zod'

import { categorize } from './category.ts'
import {
  type PathResolver,
  type SourceReader,
  type SourceText,
  codePointsToUnits,
  lineLength,
  pathResolver,
  positionAt,
  sourceReader,
  textIn,
} from './text.ts'
import type { LintFindings } from './types.ts'

/** What decides whether a fix keeps behavior. */
export interface FixContext {
  fix: Fix
  result: Result
  rule?: ReportingDescriptor
}

export interface ParseSarifOptions {
  /** Project directory; file paths in issues and edits are relative to it. */
  dir: string
  /** Overrides the tool name from the log (`runs[].tool.driver.name`). */
  tool?: string
  /** Where file contents come from, to fill `oldText` and snippets. Defaults to the disk under `dir`. */
  files?: SourceReader
  /**
   * Whether a fix is `safe`. Defaults to an explicit marker on the fix (`properties.safe === true`
   * or `properties.applicability === 'safe'`); everything else is `review`.
   */
  isSafeFix?: (context: FixContext) => boolean
}

const runsShape = z.object({
  runs: z.array(z.object({ tool: z.object({ driver: z.object({ name: z.string() }) }) })),
})
const logShape = z.custom<Log>((value) => runsShape.safeParse(value).success, 'not a SARIF log')

const uriToPath = (value: string) =>
  value.startsWith('file:') ? fileURLToPath(value) : decodeURIComponent(value)

const defaultIsSafe = ({ fix }: FixContext) =>
  fix.properties?.['safe'] === true || fix.properties?.['applicability'] === 'safe'

const severities: Record<string, IssueSeverity> = {
  error: 'error',
  warning: 'warning',
  note: 'info',
  none: 'info',
}

function findRule(run: Run, result: Result): ReportingDescriptor | undefined {
  const rules = run.tool.driver.rules ?? []
  const index = result.ruleIndex ?? result.rule?.index
  if (index !== undefined && index >= 0 && rules[index]) return rules[index]
  const id = result.ruleId ?? result.rule?.id
  return id === undefined ? undefined : rules.find((rule) => rule.id === id)
}

function messageText(result: Result, rule: ReportingDescriptor | undefined): string {
  const { message } = result
  const template =
    message.text ??
    message.markdown ??
    (message.id
      ? (rule?.messageStrings?.[message.id]?.text ?? rule?.messageStrings?.[message.id]?.markdown)
      : undefined)
  if (!template) return rule?.shortDescription?.text ?? result.ruleId ?? 'problem'
  return template.replace(
    /\{(\d+)\}/g,
    (whole, index: string) => message.arguments?.[Number(index)] ?? whole,
  )
}

function locationPath(
  location: ArtifactLocation | undefined,
  run: Run,
  paths: PathResolver,
): string | undefined {
  const uri =
    location?.uri ??
    (location?.index === undefined ? undefined : run.artifacts?.[location.index]?.location?.uri)
  if (!uri) return undefined
  try {
    const baseUri = location?.uriBaseId
      ? run.originalUriBaseIds?.[location.uriBaseId]?.uri
      : undefined
    return paths.relative(uriToPath(uri), baseUri ? uriToPath(baseUri) : undefined)
  } catch {
    return undefined
  }
}

/**
 * Converts a SARIF region into an end-exclusive UTF-16 `Range`. Missing columns follow the spec:
 * the region starts at column 1 and runs to the end of its last line.
 */
export function regionToRange(
  region: Region,
  source: SourceText | undefined,
  codePoints: boolean,
): Range | undefined {
  if (region.startLine !== undefined) {
    const startLine = region.startLine
    const endLine = region.endLine ?? startLine
    const column = (line: number, value: number) => {
      const text = source?.lines[line - 1]
      return codePoints && text !== undefined ? codePointsToUnits(text, value - 1) + 1 : value
    }
    const start = { line: startLine, column: column(startLine, region.startColumn ?? 1) }
    if (region.endColumn !== undefined)
      return { start, end: { line: endLine, column: column(endLine, region.endColumn) } }
    if (!source) return { start, end: { line: endLine, column: start.column } }
    return { start, end: { line: endLine, column: lineLength(source, endLine) + 1 } }
  }
  if (region.charOffset !== undefined && region.charOffset >= 0 && source) {
    const start = codePoints ? codePointsToUnits(source.text, region.charOffset) : region.charOffset
    const end = codePoints
      ? codePointsToUnits(source.text, region.charLength ?? 0, start)
      : start + (region.charLength ?? 0)
    return { start: positionAt(source.text, start), end: positionAt(source.text, end) }
  }
  return undefined
}

/** Results a tool reported but marked as suppressed in source or a baseline. */
const isSuppressed = (result: Result) =>
  (result.suppressions ?? []).some((suppression) => suppression.status !== 'rejected') ||
  result.kind === 'pass' ||
  result.kind === 'notApplicable'

interface RunContext {
  run: Run
  tool: string
  files: SourceReader
  paths: PathResolver
  codePoints: boolean
  isSafeFix: (context: FixContext) => boolean
}

async function fixToChange(
  context: RunContext,
  fix: Fix,
  result: Result,
  rule: ReportingDescriptor | undefined,
  id: string,
  fallbackTitle: string,
): Promise<CodeChange | undefined> {
  const edits: Edit[] = []
  for (const artifactChange of fix.artifactChanges) {
    const file = locationPath(artifactChange.artifactLocation, context.run, context.paths)
    if (!file) return undefined
    // Sequential on purpose: reads are cached per file and fixes rarely touch more than one.
    // oxlint-disable-next-line no-await-in-loop
    const source = await context.files.read(file)
    if (!source) return undefined
    for (const replacement of artifactChange.replacements) {
      const range = regionToRange(replacement.deletedRegion, source, context.codePoints)
      const oldText = range && textIn(source, range)
      if (!range || oldText === undefined) return undefined
      edits.push({
        kind: 'replace',
        file,
        range,
        oldText,
        newText: replacement.insertedContent?.text ?? '',
      })
    }
  }
  if (edits.length === 0) return undefined
  const description = fix.description?.text ?? fix.description?.markdown
  return {
    id,
    title: description ?? fallbackTitle,
    confidence: context.isSafeFix({ fix, result, ...(rule ? { rule } : {}) }) ? 'safe' : 'review',
    source: context.tool,
    edits,
  }
}

async function resultToFindings(context: RunContext, result: Result, findings: LintFindings) {
  const rule = findRule(context.run, result)
  const ruleId = result.ruleId ?? result.rule?.id ?? rule?.id ?? 'unknown'
  const message = messageText(result, rule)
  const physical = result.locations?.find((location) => location.physicalLocation)?.physicalLocation
  const file = locationPath(physical?.artifactLocation, context.run, context.paths)
  const source = file ? await context.files.read(file) : undefined
  const range = physical?.region
    ? regionToRange(physical.region, source, context.codePoints)
    : undefined
  const snippet =
    (source && range ? textIn(source, range) : undefined) ??
    physical?.region?.snippet?.text ??
    message

  const level = result.level ?? rule?.defaultConfiguration?.level ?? 'warning'
  const properties = { ...rule?.properties, ...result.properties }
  const hints = [
    ...(Array.isArray(properties['tags']) ? properties['tags'] : []),
    properties['category'],
  ]
  const securitySeverity = properties['security-severity']
  const category = securitySeverity === undefined ? categorize(ruleId, hints) : 'security'
  const help = rule?.help?.text ?? rule?.fullDescription?.text ?? rule?.shortDescription?.text
  const url = rule?.helpUri

  const id = stableId(context.tool, ruleId, file, snippet.trim())
  const issue: QualityIssue = {
    id,
    tool: context.tool,
    rule: ruleId,
    category,
    severity: severities[level] ?? 'warning',
    message,
    ...(file ? { file } : {}),
    ...(range ? { range } : {}),
    ...(help && help !== message ? { help } : {}),
    ...(url ? { url } : {}),
  }

  const fixes = result.fixes ?? []
  for (const [index, fix] of fixes.entries()) {
    // oxlint-disable-next-line no-await-in-loop
    const change = await fixToChange(
      context,
      fix,
      result,
      rule,
      stableId(id, 'fix', index),
      `${ruleId}: ${message}`,
    )
    if (!change) continue
    findings.changes.push(change)
    issue.changeId ??= change.id
  }
  findings.issues.push(issue)
}

/**
 * Converts a SARIF 2.1.0 log into issues and code changes. Paths become relative to `dir`, ranges
 * become 1-based end-exclusive UTF-16 positions, and `fixes` become `replace` edits whose
 * `oldText` is read from the file — a fix whose region cannot be located is dropped, its issue
 * is kept. Suppressed results are skipped. Throws when `log` is not SARIF.
 */
export async function parseSarif(
  log: Log | string,
  options: ParseSarifOptions,
): Promise<LintFindings> {
  const parsed: unknown = typeof log === 'string' ? JSON.parse(log) : log
  const sarif = logShape.parse(parsed)
  const files = options.files ?? sourceReader(options.dir)
  const paths = await pathResolver(options.dir)
  const findings: LintFindings = { issues: [], changes: [] }

  for (const run of sarif.runs) {
    const context: RunContext = {
      run,
      tool: options.tool ?? run.tool.driver.name,
      files,
      paths,
      codePoints: (run.columnKind ?? 'unicodeCodePoints') === 'unicodeCodePoints',
      isSafeFix: options.isSafeFix ?? defaultIsSafe,
    }
    for (const result of run.results ?? []) {
      if (isSuppressed(result)) continue
      // oxlint-disable-next-line no-await-in-loop
      await resultToFindings(context, result, findings)
    }
  }
  return findings
}
