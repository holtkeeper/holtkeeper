import type { Rule, SgNode } from '@ast-grep/napi'

import type {
  LanguageSpec,
  NameKind,
  ParserName,
  RenameScope,
  SourceFile,
} from './languages/types.ts'
import { adaptRule } from './rules.ts'

/** A declared name found in a file. */
export interface DeclaredName {
  kind: NameKind
  node: SgNode
  name: string
  /** Where a rename stays correct; `none` when the name is visible outside the file. */
  scope: RenameScope
  /** The node references are renamed in: the file root or the enclosing function. */
  scopeNode?: SgNode
}

/**
 * The function scope a node lives in, or `undefined` at module level. A function's own name
 * belongs to the scope around the function, not to the function.
 */
export function enclosingFunction(spec: LanguageSpec, node: SgNode): SgNode | undefined {
  const parent = node.parent()
  return node
    .ancestors()
    .find(
      (ancestor) =>
        spec.functionScopes.includes(String(ancestor.kind())) && ancestor.id() !== parent?.id(),
    )
}

const adapted = new Map<ParserName, Map<NameKind, Rule | undefined>>()

function ruleFor(parser: ParserName, kind: NameKind): Rule | undefined {
  let rules = adapted.get(parser)
  if (!rules) adapted.set(parser, (rules = new Map()))
  if (!rules.has(kind)) rules.set(kind, adaptRule(parser, kind.rule))
  return rules.get(kind)
}

/** Every declared name of every kind in `file`; a node belongs to the first kind that matches it. */
export function collectNames(spec: LanguageSpec, file: SourceFile): DeclaredName[] {
  const seen = new Set<number>()
  const names: DeclaredName[] = []
  for (const kind of spec.kinds) {
    const rule = ruleFor(file.parser, kind)
    if (!rule) continue
    for (const node of file.root.findAll({ rule })) {
      if (seen.has(node.id())) continue
      if (kind.when && !kind.when(node, file)) continue
      seen.add(node.id())
      names.push({ kind, node, name: node.text(), ...placement(spec, kind, node, file) })
    }
  }
  return names.toSorted((a, b) => a.node.range().start.index - b.node.range().start.index)
}

function placement(
  spec: LanguageSpec,
  kind: NameKind,
  node: SgNode,
  file: SourceFile,
): { scope: RenameScope; scopeNode?: SgNode } {
  if (kind.scope === 'none') return { scope: 'none' }
  const fn = enclosingFunction(spec, node)
  if (fn) return { scope: 'local', scopeNode: fn }
  if (kind.scope === 'local' || spec.isPublic(node, file)) return { scope: 'none' }
  return { scope: 'module', scopeNode: file.root }
}
