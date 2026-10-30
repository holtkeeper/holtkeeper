import type { Rule } from '@ast-grep/napi'

import type { LanguageSpec, NameKind, Relation } from './types.ts'

const FUNCTION_SCOPES = [
  'function_declaration',
  'lambda_literal',
  'anonymous_function',
  'getter',
  'setter',
]
const property: Rule = { kind: 'variable_declaration', inside: { kind: 'property_declaration' } }
const inFunction: Relation = { stopBy: 'end', any: FUNCTION_SCOPES.map((kind) => ({ kind })) }

const kinds: NameKind[] = [
  {
    id: 'constant',
    label: 'constant',
    rule: { kind: 'simple_identifier', inside: property },
    when: (name) =>
      /\bconst\b/.test(
        name
          .parent()
          ?.parent()
          ?.find({ rule: { kind: 'modifiers' } })
          ?.text() ?? '',
      ),
  },
  {
    id: 'local-variable',
    label: 'local variable',
    rule: {
      kind: 'simple_identifier',
      inside: { ...property, inside: { kind: 'property_declaration', inside: inFunction } },
    },
    scope: 'local',
  },
  { id: 'property', label: 'property', rule: { kind: 'simple_identifier', inside: property } },
  {
    id: 'method',
    label: 'method',
    rule: {
      kind: 'simple_identifier',
      inside: { kind: 'function_declaration', inside: { kind: 'class_body' } },
    },
  },
  {
    id: 'function',
    label: 'function',
    rule: { kind: 'simple_identifier', inside: { kind: 'function_declaration' } },
  },
  {
    id: 'type',
    label: 'type',
    rule: {
      kind: 'type_identifier',
      inside: {
        any: ['class_declaration', 'object_declaration', 'type_alias'].map((kind) => ({ kind })),
      },
    },
  },
  {
    id: 'enum-entry',
    label: 'enum entry',
    rule: { kind: 'simple_identifier', inside: { kind: 'enum_entry' } },
  },
]

/** Kotlin. Declarations are visible beyond the file, so only local variables get rename suggestions. */
export const kotlin: LanguageSpec = {
  id: 'kotlin',
  extensions: ['kt', 'kts'],
  parser: () => 'kotlin',
  dynamic: async () => (await import('@ast-grep/lang-kotlin')).default,
  kinds,
  identifiers: ['simple_identifier', 'interpolated_identifier'],
  functionScopes: FUNCTION_SCOPES,
  isPublic: () => true,
  reference(node) {
    const parent = node.parent()
    if (parent?.kind() === 'navigation_suffix') return 'skip'
    if (parent?.kind() === 'value_argument' && node.next()?.text() === '=') return 'skip'
    return 'rename'
  },
}
