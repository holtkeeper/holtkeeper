import type { Rule } from '@ast-grep/napi'

import type { LanguageSpec, NameKind } from './types.ts'

const FUNCTION_SCOPES = ['method_declaration', 'constructor_declaration', 'lambda_expression']
const field: Rule = { kind: 'variable_declarator', inside: { kind: 'field_declaration' } }

const kinds: NameKind[] = [
  {
    id: 'constant',
    label: 'constant',
    rule: { kind: 'identifier', inside: { ...field, field: 'name' } },
    when: (name) => {
      const modifiers =
        name
          .parent()
          ?.parent()
          ?.find({ rule: { kind: 'modifiers' } })
          ?.text() ?? ''
      return /\bstatic\b/.test(modifiers) && /\bfinal\b/.test(modifiers)
    },
  },
  {
    id: 'field',
    label: 'field',
    rule: { kind: 'identifier', inside: { ...field, field: 'name' } },
  },
  {
    id: 'method',
    label: 'method',
    rule: { kind: 'identifier', inside: { kind: 'method_declaration', field: 'name' } },
  },
  {
    id: 'type',
    label: 'type',
    rule: {
      kind: 'identifier',
      inside: {
        any: [
          'class_declaration',
          'interface_declaration',
          'enum_declaration',
          'record_declaration',
        ].map((kind) => ({
          kind,
        })),
        field: 'name',
      },
    },
  },
  {
    id: 'enum-constant',
    label: 'enum constant',
    rule: { kind: 'identifier', inside: { kind: 'enum_constant', field: 'name' } },
  },
  {
    id: 'local-variable',
    label: 'local variable',
    rule: {
      kind: 'identifier',
      inside: {
        kind: 'variable_declarator',
        field: 'name',
        inside: { kind: 'local_variable_declaration' },
      },
    },
    scope: 'local',
  },
]

/** Java. Members are reachable from other classes, so only local variables get rename suggestions. */
export const java: LanguageSpec = {
  id: 'java',
  extensions: ['java'],
  parser: () => 'java',
  dynamic: async () => (await import('@ast-grep/lang-java')).default,
  kinds,
  identifiers: ['identifier'],
  functionScopes: FUNCTION_SCOPES,
  isPublic: () => true,
  reference(node) {
    const parent = node.parent()
    if (parent?.kind() === 'field_access' && parent.field('field')?.id() === node.id())
      return 'skip'
    if (parent?.kind() === 'method_invocation' && parent.field('name')?.id() === node.id())
      return 'skip'
    return 'rename'
  },
}
