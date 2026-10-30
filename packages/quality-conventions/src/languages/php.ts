import type { LanguageSpec, NameKind } from './types.ts'

const FUNCTION_SCOPES = [
  'function_definition',
  'method_declaration',
  'anonymous_function',
  'arrow_function',
]

const kinds: NameKind[] = [
  {
    id: 'constant',
    label: 'constant',
    scope: 'none',
    rule: { kind: 'name', inside: { kind: 'const_element' } },
  },
  {
    id: 'function',
    label: 'function',
    scope: 'none',
    rule: { kind: 'name', inside: { kind: 'function_definition', field: 'name' } },
  },
  {
    id: 'method',
    label: 'method',
    scope: 'none',
    rule: { kind: 'name', inside: { kind: 'method_declaration', field: 'name' } },
  },
  {
    id: 'type',
    label: 'type',
    scope: 'none',
    rule: {
      kind: 'name',
      inside: {
        any: [
          'class_declaration',
          'interface_declaration',
          'trait_declaration',
          'enum_declaration',
        ].map((kind) => ({
          kind,
        })),
        field: 'name',
      },
    },
  },
  {
    id: 'property',
    label: 'property',
    scope: 'none',
    rule: { kind: 'name', inside: { kind: 'variable_name', inside: { kind: 'property_element' } } },
  },
  {
    id: 'local-variable',
    label: 'local variable',
    scope: 'none',
    rule: {
      kind: 'name',
      inside: {
        kind: 'variable_name',
        inside: {
          kind: 'assignment_expression',
          field: 'left',
          inside: { stopBy: 'end', any: FUNCTION_SCOPES.map((kind) => ({ kind })) },
        },
      },
    },
  },
]

/**
 * PHP. Reported only: variables are also reachable through strings (`compact`, `$$name`,
 * interpolation), so no rename is suggested.
 */
export const php: LanguageSpec = {
  id: 'php',
  extensions: ['php'],
  parser: () => 'php',
  dynamic: async () => (await import('@ast-grep/lang-php')).default,
  kinds,
  identifiers: ['name'],
  functionScopes: FUNCTION_SCOPES,
  isPublic: () => true,
}
