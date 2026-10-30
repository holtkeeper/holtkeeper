import type { CodeChange } from '@holtkeeper/changes'
import { type QualityIssue, stableId } from '@holtkeeper/quality'
import { z } from 'zod'

import { categorize } from './category.ts'
import {
  type SourceReader,
  type SourceText,
  pathResolver,
  positionAt,
  sourceReader,
  textIn,
} from './text.ts'
import type { LintFindings } from './types.ts'

const fixSchema = z.object({
  range: z.tuple([z.number().int(), z.number().int()]),
  text: z.string(),
})

const messageSchema = z.object({
  ruleId: z.string().nullish(),
  severity: z.number(),
  message: z.string(),
  fatal: z.boolean().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  endLine: z.number().int().optional(),
  endColumn: z.number().int().optional(),
  fix: fixSchema.optional(),
  suggestions: z.array(z.object({ desc: z.string().optional(), fix: fixSchema })).optional(),
})

const resultSchema = z.object({ filePath: z.string(), messages: z.array(messageSchema) })

const ruleMetaSchema = z.object({
  type: z.string().optional(),
  docs: z.object({ description: z.string().optional(), url: z.string().optional() }).optional(),
})

const reportSchema = z.union([
  z.array(resultSchema),
  z.object({
    results: z.array(resultSchema),
    metadata: z.object({ rulesMeta: z.record(z.string(), ruleMetaSchema).optional() }).optional(),
  }),
])

type EslintFix = z.infer<typeof fixSchema>

export interface ParseEslintJsonOptions {
  dir: string
  /** Defaults to the disk under `dir`. */
  files?: SourceReader
}

function fixEdit(source: SourceText, file: string, fix: EslintFix) {
  // ESLint reports offsets into the text with its byte-order mark stripped.
  const shift = source.text.startsWith('\uFEFF') ? 1 : 0
  const range = {
    start: positionAt(source.text, fix.range[0] + shift),
    end: positionAt(source.text, fix.range[1] + shift),
  }
  const oldText = textIn(source, range)
  return oldText === undefined
    ? undefined
    : { kind: 'replace' as const, file, range, oldText, newText: fix.text }
}

/**
 * Converts ESLint's `json` or `json-with-metadata` output into issues and changes. `fix` becomes
 * a `safe` change (what `eslint --fix` would apply), every suggestion a `review` change; the issue
 * points at the fix, or at its first suggestion when there is no fix. Throws when `report` has
 * neither shape.
 */
export async function parseEslintJson(
  report: unknown,
  options: ParseEslintJsonOptions,
): Promise<LintFindings> {
  const parsed = reportSchema.parse(typeof report === 'string' ? JSON.parse(report) : report)
  const results = Array.isArray(parsed) ? parsed : parsed.results
  const rulesMeta = Array.isArray(parsed) ? {} : (parsed.metadata?.rulesMeta ?? {})
  const files = options.files ?? sourceReader(options.dir)
  const paths = await pathResolver(options.dir)
  const findings: LintFindings = { issues: [], changes: [] }

  for (const result of results) {
    const file = paths.relative(result.filePath)
    // oxlint-disable-next-line no-await-in-loop
    const source = await files.read(file)
    for (const message of result.messages) {
      const rule = message.ruleId ?? (message.fatal ? 'fatal' : 'unknown')
      const meta = message.ruleId ? rulesMeta[message.ruleId] : undefined
      const range =
        message.line === undefined
          ? undefined
          : {
              start: { line: message.line, column: message.column ?? 1 },
              end: {
                line: message.endLine ?? message.line,
                column: message.endColumn ?? message.column ?? 1,
              },
            }
      const snippet = (source && range ? textIn(source, range) : undefined) ?? message.message
      const id = stableId('eslint', rule, file, snippet.trim())
      const help = meta?.docs?.description
      const issue: QualityIssue = {
        id,
        tool: 'eslint',
        rule,
        category: categorize(rule, [meta?.type]),
        severity: message.severity >= 2 ? 'error' : 'warning',
        message: message.message,
        file,
        ...(range ? { range } : {}),
        ...(help ? { help } : {}),
        ...(meta?.docs?.url ? { url: meta.docs.url } : {}),
      }

      const proposals: {
        fix: EslintFix
        title: string
        confidence: CodeChange['confidence']
        key: string
      }[] = []
      if (message.fix)
        proposals.push({ fix: message.fix, title: `Fix ${rule}`, confidence: 'safe', key: 'fix' })
      for (const [index, suggestion] of (message.suggestions ?? []).entries()) {
        proposals.push({
          fix: suggestion.fix,
          title: suggestion.desc ?? `Suggestion for ${rule}`,
          confidence: 'review',
          key: `suggestion-${index}`,
        })
      }
      for (const proposal of proposals) {
        const edit = source && fixEdit(source, file, proposal.fix)
        if (!edit) continue
        const change: CodeChange = {
          id: stableId(id, proposal.key),
          title: proposal.title,
          description: message.message,
          confidence: proposal.confidence,
          source: 'eslint',
          edits: [edit],
        }
        findings.changes.push(change)
        issue.changeId ??= change.id
      }
      findings.issues.push(issue)
    }
  }
  return findings
}
