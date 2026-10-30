import type { Rule, SgNode } from '@ast-grep/napi'

import type { LanguageSpec, NameKind } from './types.ts'

const FUNCTION_SCOPES = ['function_declaration', 'method_declaration', 'func_literal']
const topLevel: Rule = { inside: { kind: 'source_file' } }
const isExported = (name: SgNode) => /^\p{Lu}/u.test(name.text())

function split(id: string, label: string, rule: Rule): NameKind[] {
  return [
    { id: `exported-${id}`, label: `exported ${label}`, rule, when: isExported },
    { id, label: `unexported ${label}`, rule, when: (name) => !isExported(name) },
  ]
}

const kinds: NameKind[] = [
  ...split('constant', 'constant', {
    kind: 'identifier',
    inside: {
      kind: 'const_spec',
      field: 'name',
      inside: { kind: 'const_declaration', ...topLevel },
    },
  }),
  ...split('variable', 'variable', {
    kind: 'identifier',
    inside: { kind: 'var_spec', field: 'name', inside: { kind: 'var_declaration', ...topLevel } },
  }),
  ...split('function', 'function', {
    kind: 'identifier',
    inside: { kind: 'function_declaration', field: 'name' },
  }),
  ...split('method', 'method', {
    kind: 'field_identifier',
    inside: { kind: 'method_declaration', field: 'name' },
  }),
  ...split('type', 'type', {
    kind: 'type_identifier',
    inside: { kind: 'type_spec', field: 'name', inside: { kind: 'type_declaration', ...topLevel } },
  }),
  {
    id: 'local-variable',
    label: 'local variable',
    rule: {
      kind: 'identifier',
      any: [
        {
          inside: {
            kind: 'expression_list',
            inside: {
              any: [{ kind: 'short_var_declaration' }, { kind: 'range_clause' }],
              field: 'left',
            },
          },
        },
        { inside: { any: [{ kind: 'var_spec' }, { kind: 'const_spec' }], field: 'name' } },
      ],
      inside: { stopBy: 'end', any: FUNCTION_SCOPES.map((kind) => ({ kind })) },
    },
    scope: 'local',
  },
]

/** Go. Top-level names are package-scoped, so only local variables get rename suggestions. */
export const go: LanguageSpec = {
  id: 'go',
  extensions: ['go'],
  parser: () => 'go',
  dynamic: async () => (await import('@ast-grep/lang-go')).default,
  kinds,
  identifiers: ['identifier'],
  functionScopes: FUNCTION_SCOPES,
  isPublic: () => true,
  reference(node) {
    const parent = node.parent()
    if (parent?.kind() === 'literal_element' && parent.parent()?.kind() === 'keyed_element') {
      return parent.parent()?.namedChildren()[0]?.id() === parent.id() ? 'abort' : 'rename'
    }
    return 'rename'
  },
}
