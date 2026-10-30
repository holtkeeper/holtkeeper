import type { CodeChange, FileAccess, Range } from '@holtkeeper/changes'
import { type IssueSeverity, type QualityIssue, stableId } from '@holtkeeper/quality'

import { type ExportTarget, removeExportEdits } from './exports.ts'
import { type DependencyField, removeDependencyEdit } from './package-json.ts'
import type { KnipReport, KnipRow, KnipSymbol } from './report.ts'

/** What a knip report contributes: issues, and the removals proposed for some of them. */
export interface DeadCodeFindings {
  issues: QualityIssue[]
  /** Every change is referenced by the `changeId` of the issues it resolves. */
  changes: CodeChange[]
}

type SymbolType = Exclude<keyof KnipRow, 'file' | 'duplicates' | 'cycles'>

interface RuleInfo {
  rule: string
  severity: IssueSeverity
  message: (symbol: KnipSymbol) => string
}

const member = (kind: string) => (symbol: KnipSymbol) =>
  `Unused ${kind} ${symbol.namespace ? `${symbol.namespace}.` : ''}${symbol.name}`

/** knip issue type → rule, severity and message. Types knip adds later are ignored until listed here. */
export const knipRules: Record<SymbolType, RuleInfo> = {
  files: { rule: 'deadcode/unused-file', severity: 'info', message: () => 'Unused file' },
  dependencies: {
    rule: 'deadcode/unused-dependency',
    severity: 'info',
    message: (s) => `Unused dependency ${s.name}`,
  },
  devDependencies: {
    rule: 'deadcode/unused-dev-dependency',
    severity: 'info',
    message: (s) => `Unused devDependency ${s.name}`,
  },
  optionalPeerDependencies: {
    rule: 'deadcode/referenced-optional-peer',
    severity: 'info',
    message: (s) => `Optional peerDependency ${s.name} is referenced`,
  },
  unlisted: {
    rule: 'deadcode/unlisted-dependency',
    severity: 'warning',
    message: (s) => `${s.name} is imported but not listed in package.json`,
  },
  binaries: {
    rule: 'deadcode/unlisted-binary',
    severity: 'warning',
    message: (s) => `Binary ${s.name} is used but no listed dependency provides it`,
  },
  unresolved: {
    rule: 'deadcode/unresolved-import',
    severity: 'warning',
    message: (s) => `Cannot resolve import ${s.name}`,
  },
  exports: { rule: 'deadcode/unused-export', severity: 'info', message: member('export') },
  nsExports: {
    rule: 'deadcode/unused-namespace-export',
    severity: 'info',
    message: member('export (used through a namespace)'),
  },
  types: { rule: 'deadcode/unused-type', severity: 'info', message: member('exported type') },
  nsTypes: {
    rule: 'deadcode/unused-namespace-type',
    severity: 'info',
    message: member('exported type (used through a namespace)'),
  },
  enumMembers: {
    rule: 'deadcode/unused-enum-member',
    severity: 'info',
    message: member('enum member'),
  },
  namespaceMembers: {
    rule: 'deadcode/unused-namespace-member',
    severity: 'info',
    message: member('namespace member'),
  },
  classMembers: {
    rule: 'deadcode/unused-class-member',
    severity: 'info',
    message: member('class member'),
  },
  catalog: {
    rule: 'deadcode/unused-catalog-entry',
    severity: 'info',
    message: (s) => `Unused catalog entry ${s.name}`,
  },
  catalogReferences: {
    rule: 'deadcode/unresolved-catalog-reference',
    severity: 'warning',
    message: (s) => `Catalog entry ${s.name} does not exist`,
  },
}

const symbolTypes = Object.keys(knipRules).filter((key): key is SymbolType => key in knipRules)

const dependencyFields: Partial<Record<SymbolType, DependencyField>> = {
  dependencies: 'dependencies',
  devDependencies: 'devDependencies',
}

const exportTypes: ReadonlySet<SymbolType> = new Set(['exports', 'types'])

const toPosix = (path: string) => path.replaceAll('\\', '/')

function rangeOf(symbol: KnipSymbol, text: string | undefined): Range | undefined {
  if (symbol.line === undefined || symbol.col === undefined) return undefined
  const start = { line: symbol.line, column: symbol.col }
  const line = text?.split('\n')[symbol.line - 1]
  const length = line?.startsWith(symbol.name, symbol.col - 1) ? symbol.name.length : 0
  return { start, end: { line: symbol.line, column: symbol.col + length } }
}

const at = (symbol: KnipSymbol) =>
  symbol.line === undefined || symbol.col === undefined
    ? undefined
    : { line: symbol.line, column: symbol.col }

/**
 * Turns a knip JSON report into `QualityIssue`s (category `lint`, tool `knip`, rules
 * `deadcode/*`) and `review` changes from source `knip`: deleting each unused file, removing each
 * unused dependency from its `package.json`, and un-exporting the unused exports and types of a
 * file (one change per file). File texts come from `files`; a change whose text cannot be located
 * is not proposed, the issue stays.
 */
export async function knipFindings(
  report: KnipReport,
  files: FileAccess,
): Promise<DeadCodeFindings> {
  const findings: DeadCodeFindings = { issues: [], changes: [] }
  const texts = new Map<string, Promise<string | undefined>>()
  const read = (file: string) => {
    let text = texts.get(file)
    if (!text) {
      text = files.read(file).catch(() => undefined)
      texts.set(file, text)
    }
    return text
  }

  for (const row of report.issues) {
    const file = toPosix(row.file)
    // oxlint-disable-next-line no-await-in-loop
    const text = await read(file)
    const exportIssues: { issue: QualityIssue; target: ExportTarget }[] = []

    for (const type of symbolTypes) {
      const info = knipRules[type]
      for (const symbol of row[type] ?? []) {
        const subject = type === 'files' ? toPosix(symbol.name) : file
        const range = type === 'files' ? undefined : rangeOf(symbol, text)
        const issue: QualityIssue = {
          id: stableId('knip', info.rule, subject, symbol.namespace, symbol.name),
          tool: 'knip',
          rule: info.rule,
          category: 'lint',
          severity: info.severity,
          message: info.message(symbol),
          file: subject,
          ...(range ? { range } : {}),
        }
        findings.issues.push(issue)

        const field = dependencyFields[type]
        if (type === 'files') {
          // oxlint-disable-next-line no-await-in-loop
          const content = subject === file ? text : await read(subject)
          if (content === undefined) continue
          const change: CodeChange = {
            id: stableId('knip', 'delete-file', subject),
            title: `Delete unused file ${subject}`,
            confidence: 'review',
            source: 'knip',
            edits: [{ kind: 'delete', file: subject, oldText: content }],
          }
          findings.changes.push(change)
          issue.changeId = change.id
        } else if (field && text !== undefined) {
          const edit = removeDependencyEdit(text, file, field, symbol.name, at(symbol))
          if (!edit) continue
          const change: CodeChange = {
            id: stableId('knip', 'remove-dependency', file, field, symbol.name),
            title: `Remove unused ${field === 'devDependencies' ? 'devDependency' : 'dependency'} ${symbol.name}`,
            description: `Not imported anywhere; removes it from ${field} in ${file}.`,
            confidence: 'review',
            source: 'knip',
            edits: [edit],
          }
          findings.changes.push(change)
          issue.changeId = change.id
        } else if (exportTypes.has(type) && !symbol.namespace) {
          const position = at(symbol)
          if (position) exportIssues.push({ issue, target: { name: symbol.name, at: position } })
        }
      }
    }

    for (const group of row.duplicates ?? []) {
      const first = group[0]
      if (!first) continue
      const names = group.map((symbol) => symbol.name)
      const range = rangeOf(first, text)
      findings.issues.push({
        id: stableId('knip', 'deadcode/duplicate-export', file, names.join(',')),
        tool: 'knip',
        rule: 'deadcode/duplicate-export',
        category: 'lint',
        severity: 'info',
        message: `The same value is exported as ${names.join(', ')}`,
        file,
        ...(range ? { range } : {}),
      })
    }

    for (const cycle of row.cycles ?? []) {
      const names = cycle.map((symbol) => symbol.name)
      findings.issues.push({
        id: stableId('knip', 'deadcode/circular-dependency', file, names.join(',')),
        tool: 'knip',
        rule: 'deadcode/circular-dependency',
        category: 'lint',
        severity: 'info',
        message: `Circular import: ${[file, ...names].join(' → ')}`,
        file,
      })
    }

    if (text === undefined || exportIssues.length === 0) continue
    const { edits, removed } = removeExportEdits(
      text,
      file,
      exportIssues.map(({ target }) => target),
    )
    if (edits.length === 0) continue
    const covered = exportIssues.filter(({ target }) => removed.includes(target))
    const names = covered.map(({ target }) => target.name)
    const change: CodeChange = {
      id: stableId('knip', 'remove-exports', file, names.toSorted().join(',')),
      title: `Stop exporting ${names.length === 1 ? names[0] : `${names.length} unused exports`} in ${file}`,
      description: `Nothing imports ${names.join(', ')}; the declarations stay, only the exports go.`,
      confidence: 'review',
      source: 'knip',
      edits,
    }
    findings.changes.push(change)
    for (const { issue } of covered) issue.changeId = change.id
  }
  return findings
}
