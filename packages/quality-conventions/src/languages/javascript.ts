import { Lang, type Rule, type SgNode } from '@ast-grep/napi'

import type { LanguageSpec, NameKind, ReferenceAction, Relation, SourceFile } from './types.ts'

const FUNCTION_SCOPES = [
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
  'class_static_block',
]

const atModuleLevel: Rule = {
  any: [{ kind: 'program' }, { kind: 'export_statement', inside: { kind: 'program' } }],
}
const declaration: Rule = {
  any: [{ kind: 'lexical_declaration' }, { kind: 'variable_declaration' }],
}
const moduleDeclaration: Rule = { ...declaration, inside: atModuleLevel }
const functionValue: Relation = {
  field: 'value',
  any: [{ kind: 'arrow_function' }, { kind: 'function_expression' }],
}

const declaredFunction = (level?: Rule): Rule => ({
  any: [
    {
      inside: {
        any: [{ kind: 'function_declaration' }, { kind: 'generator_function_declaration' }],
        field: 'name',
        ...(level ? { inside: level } : {}),
      },
    },
    {
      inside: {
        kind: 'variable_declarator',
        field: 'name',
        has: functionValue,
        inside: level ? { ...declaration, inside: level } : declaration,
      },
    },
  ],
})

function functionOf(name: SgNode): SgNode | undefined {
  const parent = name.parent()
  if (!parent) return undefined
  return parent.kind() === 'variable_declarator' ? (parent.field('value') ?? undefined) : parent
}

const TAGS = new Set(['jsx_opening_element', 'jsx_closing_element', 'jsx_self_closing_element'])
const JSX: Rule = { any: [{ kind: 'jsx_element' }, { kind: 'jsx_self_closing_element' }] }

function nearestFunction(node: SgNode): SgNode | undefined {
  return node.ancestors().find((ancestor) => FUNCTION_SCOPES.includes(String(ancestor.kind())))
}

function returnsJsx(fn: SgNode): boolean {
  const body = fn.field('body')
  if (!body) return false
  if (body.kind() !== 'statement_block')
    return body.matches({ rule: JSX }) || body.find({ rule: JSX }) !== null
  return body
    .findAll({ rule: { kind: 'return_statement' } })
    .some((ret) => nearestFunction(ret)?.id() === fn.id() && ret.find({ rule: JSX }) !== null)
}

const COMPONENT_FACTORY = /(?:^|\.)(?:lazy\w*|memo|forwardRef|createContext|styled|\w*Component)$/
const HOC = /^(?:observer|inject|connect)$/
const WRAPPER = /^with[A-Z]\w*$/
const isJsxFile = (file: SourceFile) => /\.[jt]sx$/.test(file.path)
const capitalized = (name: string) => /^[_$]*[A-Z]/.test(name)

/**
 * Whether `value` builds a component: a component factory (`memo`, `lazy`, `styled.div`...``,
 * `styled(Button).attrs()`), `observer`, `inject` or `connect(a)(B)`, or a `with*` wrapper given a
 * component (`withTheme(Card)`, `withRouter(() => <div />)`). Hooks such as `useMemo(() => <a />)`
 * build elements, not components, and `withUnit(2)` is no wrapper.
 */
function isComponentValue(value: SgNode | null, file: SourceFile): boolean {
  if (value?.kind() !== 'call_expression') return false
  const callee = value.field('function')
  if (!callee) return false
  const text = callee.text()
  if (COMPONENT_FACTORY.test(text) || /^styled\b/.test(text)) return true
  const name = text.split('.').at(-1) ?? ''
  if (HOC.test(name)) return true
  if (isComponentValue(callee, file)) return true
  return (
    WRAPPER.test(name) &&
    (value.field('arguments')?.namedChildren() ?? []).some(
      (arg) =>
        (arg.kind() === 'identifier' && capitalized(arg.text())) ||
        (isJsxFile(file) &&
          (arg.kind() === 'arrow_function' || arg.kind() === 'function_expression') &&
          returnsJsx(arg)),
    )
  )
}

const tags = new WeakMap<SourceFile, Set<string>>()

/** Names used as JSX tags (`<Icon />`, `<Context.Provider>`): values that are components. */
function jsxTags(file: SourceFile): Set<string> {
  let names = tags.get(file)
  if (!names) {
    if (!isJsxFile(file)) return new Set()
    const nodes = file.root.findAll({
      rule: {
        kind: 'identifier',
        any: [
          { inside: { any: [...TAGS].map((kind) => ({ kind })), field: 'name' } },
          {
            inside: {
              kind: 'member_expression',
              field: 'object',
              inside: { any: [...TAGS].map((kind) => ({ kind })) },
            },
          },
        ],
      },
    })
    // A lowercase tag (`<filter>`, `<path>`) is an intrinsic element, not the variable of that name.
    names = new Set(
      nodes
        .filter((node) => node.parent()?.kind() === 'member_expression' || capitalized(node.text()))
        .map((node) => node.text()),
    )
    tags.set(file, names)
  }
  return names
}

const PRIMITIVE = new Set(['string', 'number', 'true', 'false', 'null', 'undefined', 'regex'])

function isPrimitive(value: SgNode | null): boolean {
  if (!value) return false
  const kind = String(value.kind())
  if (PRIMITIVE.has(kind)) return true
  if (kind === 'template_string')
    return value.find({ rule: { kind: 'template_substitution' } }) === null
  if (kind === 'unary_expression') return isPrimitive(value.field('argument'))
  if (
    kind === 'as_expression' ||
    kind === 'satisfies_expression' ||
    kind === 'parenthesized_expression'
  ) {
    return isPrimitive(
      value.child(0)?.isNamed() ? value.child(0) : (value.namedChildren()[0] ?? null),
    )
  }
  return false
}

/** A literal made of primitives only: `1`, `'a'`, `[1, 2]`, `{ a: 1, b: ['x'] }`. */
function isLiteral(value: SgNode | null): boolean {
  if (!value) return false
  if (isPrimitive(value)) return true
  const kind = String(value.kind())
  if (kind === 'array') return value.namedChildren().every((item) => isLiteral(item))
  if (kind === 'object')
    return value
      .namedChildren()
      .every((pair) => pair.kind() === 'pair' && isLiteral(pair.field('value')))
  if (kind === 'as_expression' || kind === 'satisfies_expression')
    return isLiteral(value.namedChildren()[0] ?? null)
  return false
}

/**
 * Whether `value` only names a class or component defined elsewhere, so the variable keeps
 * its case: `require('x')`, `await import('x')`, `global.WebSocket`, `isMobile ? A : B`.
 */
function isAlias(value: SgNode | null): boolean {
  if (!value) return false
  const kind = String(value.kind())
  if (kind === 'identifier') return capitalized(value.text())
  if (kind === 'member_expression') return capitalized(value.field('property')?.text() ?? '')
  if (kind === 'ternary_expression')
    return isAlias(value.field('consequence')) && isAlias(value.field('alternative'))
  if (kind === 'parenthesized_expression') return isAlias(value.namedChildren()[0] ?? null)
  if (kind === 'await_expression') return isAlias(value.namedChildren()[0] ?? null)
  if (kind === 'call_expression') {
    const callee = value.field('function')
    return callee?.text() === 'require' || callee?.kind() === 'import'
  }
  return false
}

const notAlias = (name: SgNode) => !isAlias(name.parent()?.field('value') ?? null)

const kinds: NameKind[] = [
  {
    id: 'component',
    label: 'component',
    rule: { kind: 'identifier', ...declaredFunction() },
    when: (name, file) =>
      isJsxFile(file) && capitalized(name.text()) && returnsJsx(functionOf(name) ?? name),
  },
  {
    id: 'component',
    label: 'component',
    rule: {
      kind: 'identifier',
      inside: { kind: 'variable_declarator', field: 'name', inside: declaration },
    },
    when: (name, file) =>
      isComponentValue(name.parent()?.field('value') ?? null, file) ||
      jsxTags(file).has(name.text()),
  },
  { id: 'function', label: 'function', rule: { kind: 'identifier', ...declaredFunction() } },
  {
    id: 'module-constant',
    label: 'module constant',
    rule: {
      kind: 'identifier',
      inside: {
        kind: 'variable_declarator',
        field: 'name',
        inside: { ...moduleDeclaration, regex: '^const\\b' },
      },
    },
    when: (name) => isPrimitive(name.parent()?.field('value') ?? null),
  },
  {
    id: 'module-variable',
    label: 'module variable',
    rule: {
      kind: 'identifier',
      inside: { kind: 'variable_declarator', field: 'name', inside: moduleDeclaration },
    },
    when: notAlias,
  },
  {
    id: 'local-constant',
    label: 'local constant',
    rule: {
      kind: 'identifier',
      inside: {
        kind: 'variable_declarator',
        field: 'name',
        inside: {
          ...declaration,
          regex: '^const\\b',
          inside: { stopBy: 'end', any: FUNCTION_SCOPES.map((kind) => ({ kind })) },
        },
      },
    },
    when: (name) => isLiteral(name.parent()?.field('value') ?? null),
    scope: 'local',
  },
  {
    id: 'local-variable',
    label: 'local variable',
    rule: {
      kind: 'identifier',
      inside: {
        kind: 'variable_declarator',
        field: 'name',
        inside: {
          ...declaration,
          inside: { stopBy: 'end', any: FUNCTION_SCOPES.map((kind) => ({ kind })) },
        },
      },
    },
    when: notAlias,
    scope: 'local',
  },
  {
    id: 'class',
    label: 'class',
    rule: {
      any: [{ kind: 'type_identifier' }, { kind: 'identifier' }],
      inside: {
        any: [{ kind: 'class_declaration' }, { kind: 'abstract_class_declaration' }],
        field: 'name',
      },
    },
  },
  {
    id: 'type',
    label: 'type',
    rule: {
      kind: 'type_identifier',
      inside: {
        any: [{ kind: 'interface_declaration' }, { kind: 'type_alias_declaration' }],
        field: 'name',
      },
    },
  },
  {
    id: 'enum',
    label: 'enum',
    rule: { kind: 'identifier', inside: { kind: 'enum_declaration', field: 'name' } },
  },
  {
    id: 'enum-member',
    label: 'enum member',
    rule: {
      kind: 'property_identifier',
      any: [
        { inside: { kind: 'enum_body' } },
        { inside: { kind: 'enum_assignment', field: 'name', inside: { kind: 'enum_body' } } },
      ],
    },
    scope: 'none',
  },
  {
    id: 'method',
    label: 'method',
    rule: {
      kind: 'property_identifier',
      inside: { kind: 'method_definition', field: 'name' },
    },
    scope: 'none',
  },
]

const exportedNames = new WeakMap<SourceFile, Set<string>>()

function exported(file: SourceFile): Set<string> {
  let names = exportedNames.get(file)
  if (!names) {
    names = new Set(
      file.root
        .findAll({
          rule: {
            any: [
              { kind: 'identifier', inside: { kind: 'export_specifier', field: 'name' } },
              { kind: 'identifier', inside: { kind: 'export_statement' } },
            ],
          },
        })
        .map((node) => node.text()),
    )
    exportedNames.set(file, names)
  }
  return names
}

function isPublic(name: SgNode, file: SourceFile): boolean {
  if (file.path.endsWith('.d.ts')) return true
  const ancestors = name.ancestors()
  if (
    ancestors.some((node) =>
      ['export_statement', 'ambient_declaration', 'internal_module', 'module'].includes(
        String(node.kind()),
      ),
    )
  ) {
    return true
  }
  return exported(file).has(name.text())
}

function reference(node: SgNode, newName: string): ReferenceAction {
  const kind = String(node.kind())
  if (kind === 'shorthand_property_identifier') return { text: `${node.text()}: ${newName}` }
  if (kind === 'shorthand_property_identifier_pattern') return 'abort'
  if (kind === 'identifier' && TAGS.has(String(node.parent()?.kind() ?? ''))) {
    if (/^[a-z]/.test(node.text())) return 'skip'
    // `<Icon />` renamed to `<icon />` would become an intrinsic element.
    if (/^[a-z]/.test(newName)) return 'abort'
  }
  return 'rename'
}

const shared = {
  kinds,
  identifiers: [
    'identifier',
    'type_identifier',
    'shorthand_property_identifier',
    'shorthand_property_identifier_pattern',
  ],
  functionScopes: FUNCTION_SCOPES,
  isPublic,
  reference,
  fileNameKind: (path: string) => (/\.[jt]sx$/.test(path) ? 'component file name' : 'file name'),
} satisfies Partial<LanguageSpec>

/** TypeScript, including `.tsx`. */
export const typescript: LanguageSpec = {
  id: 'typescript',
  extensions: ['ts', 'mts', 'cts', 'tsx'],
  parser: (path) => (path.endsWith('.tsx') ? Lang.Tsx : Lang.TypeScript),
  ...shared,
}

/** JavaScript, including JSX. */
export const javascript: LanguageSpec = {
  id: 'javascript',
  extensions: ['js', 'mjs', 'cjs', 'jsx'],
  parser: () => Lang.JavaScript,
  ...shared,
}
