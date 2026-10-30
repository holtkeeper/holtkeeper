import type { Rule, SgNode } from '@ast-grep/napi'

import type { LanguageSpec, NameKind } from './types.ts'

const FUNCTION_SCOPES = ['function_item', 'closure_expression']
const inImpl: Rule = {
  kind: 'declaration_list',
  inside: { any: [{ kind: 'impl_item' }, { kind: 'trait_item' }] },
}

const kinds: NameKind[] = [
  {
    id: 'constant',
    label: 'constant',
    rule: {
      kind: 'identifier',
      inside: { any: [{ kind: 'const_item' }, { kind: 'static_item' }], field: 'name' },
    },
  },
  {
    id: 'method',
    label: 'method',
    rule: { kind: 'identifier', inside: { kind: 'function_item', field: 'name', inside: inImpl } },
    scope: 'none',
  },
  {
    id: 'function',
    label: 'function',
    rule: { kind: 'identifier', inside: { kind: 'function_item', field: 'name' } },
  },
  {
    id: 'type',
    label: 'type',
    rule: {
      kind: 'type_identifier',
      inside: {
        any: ['struct_item', 'enum_item', 'union_item', 'trait_item', 'type_item'].map((kind) => ({
          kind,
        })),
        field: 'name',
      },
    },
  },
  {
    id: 'enum-variant',
    label: 'enum variant',
    rule: { kind: 'identifier', inside: { kind: 'enum_variant', field: 'name' } },
    scope: 'none',
  },
  {
    id: 'local-variable',
    label: 'local variable',
    rule: { kind: 'identifier', inside: { kind: 'let_declaration', field: 'pattern' } },
    scope: 'local',
  },
]

function isPublic(name: SgNode, file: { root: SgNode }): boolean {
  if (name.parent()?.find({ rule: { kind: 'visibility_modifier' } })) return true
  // Child modules in other files see private items through `super::`.
  return (
    file.root.find({ rule: { kind: 'mod_item', not: { has: { kind: 'declaration_list' } } } }) !==
    null
  )
}

/** Rust. Non-`pub` items are renamed within the file unless it declares child module files. */
export const rust: LanguageSpec = {
  id: 'rust',
  extensions: ['rs'],
  parser: () => 'rust',
  dynamic: async () => (await import('@ast-grep/lang-rust')).default,
  kinds,
  identifiers: ['identifier', 'type_identifier', 'shorthand_field_identifier'],
  functionScopes: FUNCTION_SCOPES,
  isPublic,
  reference(node, newName) {
    if (node.kind() === 'shorthand_field_identifier') return 'abort'
    if (node.parent()?.kind() === 'shorthand_field_initializer')
      return { text: `${node.text()}: ${newName}` }
    return 'rename'
  },
  hiddenReferences: (scope, name) => new RegExp(`\\{${name}[}:]`).test(scope.text()),
}
