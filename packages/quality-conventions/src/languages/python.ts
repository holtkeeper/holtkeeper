import type { Rule, SgNode } from '@ast-grep/napi'

import type { LanguageSpec, NameKind } from './types.ts'

const FUNCTION_SCOPES = ['function_definition', 'lambda']
const PRIMITIVE = new Set(['integer', 'float', 'true', 'false', 'none', 'concatenated_string'])

function isPrimitive(value: SgNode | null): boolean {
  if (!value) return false
  const kind = String(value.kind())
  if (PRIMITIVE.has(kind)) return true
  if (kind === 'string') return value.find({ rule: { kind: 'interpolation' } }) === null
  if (kind === 'unary_operator') return isPrimitive(value.field('argument'))
  return false
}

const inClass: Rule = {
  any: [
    { kind: 'block', inside: { kind: 'class_definition' } },
    {
      kind: 'decorated_definition',
      inside: { kind: 'block', inside: { kind: 'class_definition' } },
    },
  ],
}
const moduleAssignment: Rule = {
  kind: 'assignment',
  inside: { kind: 'expression_statement', inside: { kind: 'module' } },
}

const kinds: NameKind[] = [
  {
    id: 'method',
    label: 'method',
    rule: {
      kind: 'identifier',
      inside: { kind: 'function_definition', field: 'name', inside: inClass },
    },
    scope: 'none',
  },
  {
    id: 'function',
    label: 'function',
    rule: { kind: 'identifier', inside: { kind: 'function_definition', field: 'name' } },
  },
  {
    id: 'class',
    label: 'class',
    rule: { kind: 'identifier', inside: { kind: 'class_definition', field: 'name' } },
  },
  {
    id: 'module-constant',
    label: 'module constant',
    rule: { kind: 'identifier', inside: { ...moduleAssignment, field: 'left' } },
    when: (name) => isPrimitive(name.parent()?.field('right') ?? null),
  },
  {
    id: 'module-variable',
    label: 'module variable',
    rule: { kind: 'identifier', inside: { ...moduleAssignment, field: 'left' } },
  },
  {
    id: 'local-variable',
    label: 'local variable',
    rule: {
      kind: 'identifier',
      inside: {
        kind: 'assignment',
        field: 'left',
        inside: { stopBy: 'end', any: FUNCTION_SCOPES.map((kind) => ({ kind })) },
      },
    },
    scope: 'local',
  },
]

/** Python. Module-level names are public unless they start with `_`. */
export const python: LanguageSpec = {
  id: 'python',
  extensions: ['py', 'pyi'],
  parser: () => 'python',
  dynamic: async () => (await import('@ast-grep/lang-python')).default,
  kinds,
  identifiers: ['identifier'],
  functionScopes: FUNCTION_SCOPES,
  isPublic: (name, file) => !name.text().startsWith('_') || file.path.endsWith('.pyi'),
  reference(node) {
    const parent = node.parent()
    const kind = parent?.kind()
    if (kind === 'attribute' && parent?.field('attribute')?.id() === node.id()) return 'skip'
    if (kind === 'keyword_argument' && parent?.field('name')?.id() === node.id()) return 'skip'
    return 'rename'
  },
}
