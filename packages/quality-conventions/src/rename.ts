import type { Rule, SgNode } from '@ast-grep/napi'
import type { Edit } from '@holtkeeper/changes'

import { type DeclaredName, collectNames, enclosingFunction } from './collect.ts'
import type { LanguageSpec, SourceFile } from './languages/types.ts'
import { isKind } from './rules.ts'

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')

function occurrences(spec: LanguageSpec, file: SourceFile, text: string): SgNode[] {
  const kinds = spec.identifiers.filter((kind) => isKind(file.parser, kind))
  const rule: Rule = { regex: `^${escape(text)}$`, any: kinds.map((kind) => ({ kind })) }
  return file.root.findAll({ rule })
}

const contains = (outer: SgNode, inner: SgNode) =>
  outer.range().start.index <= inner.range().start.index &&
  inner.range().end.index <= outer.range().end.index

function replace(file: SourceFile, node: SgNode, newText: string): Edit {
  const { start, end } = node.range()
  return {
    kind: 'replace',
    file: file.path,
    range: {
      start: { line: start.line + 1, column: start.column + 1 },
      end: { line: end.line + 1, column: end.column + 1 },
    },
    oldText: node.text(),
    newText,
  }
}

/**
 * Edits that rename `declared` to `newName` everywhere it is referenced in its scope, or
 * `undefined` when that cannot be done safely: the name is visible outside the file, `newName`
 * already appears in the file, the old name is declared again in the file or is visible in the
 * enclosing scope, or a reference cannot be rewritten (shorthand destructuring and the like).
 */
export function renameEdits(
  spec: LanguageSpec,
  file: SourceFile,
  declared: DeclaredName,
  newName: string,
  names: readonly DeclaredName[] = collectNames(spec, file),
): Edit[] | undefined {
  const { scopeNode, node, name, scope } = declared
  if (scope === 'none' || !scopeNode || newName === name) return undefined
  if (occurrences(spec, file, newName).length) return undefined
  if (spec.hiddenReferences?.(scopeNode, name)) return undefined
  if (
    scope === 'module' &&
    names.some((other) => other.name === name && other.node.id() !== node.id())
  )
    return undefined

  const edits: Edit[] = []
  let renamesDeclaration = false
  for (const occurrence of occurrences(spec, file, name)) {
    const action = spec.reference?.(occurrence, newName) ?? 'rename'
    if (action === 'skip') continue
    if (!contains(scopeNode, occurrence)) {
      // The same text outside a local scope is fine only when it lives in a sibling function.
      const container = enclosingFunction(spec, occurrence) ?? file.root
      if (contains(container, scopeNode)) return undefined
      continue
    }
    if (action === 'abort') return undefined
    if (occurrence.id() === node.id()) renamesDeclaration = true
    edits.push(replace(file, occurrence, action === 'rename' ? newName : action.text))
  }
  return renamesDeclaration ? edits : undefined
}
