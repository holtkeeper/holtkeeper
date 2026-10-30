import { isBuiltin } from 'node:module'

import { parseSync } from 'oxc-parser'

import type { UsageKind } from './model.ts'

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string' &&
  'start' in value &&
  typeof value.start === 'number'

const child = (node: Node, key: string): Node | undefined => {
  const value = node[key]
  return isNode(value) ? value : undefined
}

const children = (node: Node, key: string): Node[] => {
  const value = node[key]
  return Array.isArray(value) ? value.filter(isNode) : []
}

const nameOf = (node: Node | undefined): string | undefined => {
  if (!node) return undefined
  if (typeof node.name === 'string') return node.name
  if (typeof node.value === 'string') return node.value
  return undefined
}

/** A bare import specifier split into the package and the entry point. */
export interface PackageSpecifier {
  name: string
  /** `.` or `./sub/path`. */
  subpath: string
}

const packageName = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i

/**
 * The package a specifier imports, or `undefined` for relative paths, absolute paths, Node
 * built-ins, URLs, `#` subpath imports and aliases such as `@/` or `~/`.
 */
export function parseSpecifier(specifier: string): PackageSpecifier | undefined {
  if (!specifier || /^[./#~]/.test(specifier) || specifier.includes(':')) return undefined
  if (isBuiltin(specifier)) return undefined
  const parts = specifier.split('/')
  const count = specifier.startsWith('@') ? 2 : 1
  const name = parts.slice(0, count).join('/')
  if (!packageName.test(name)) return undefined
  const rest = parts.slice(count).join('/')
  return { name, subpath: rest ? `./${rest}` : '.' }
}

/** A use the scanner tied to a package by following the file's imports. */
export interface ScannedSite {
  package: string
  subpath: string
  export: string
  kind: UsageKind
  member?: string
  props?: string[]
  spread?: boolean
  /** UTF-16 offset of the name. */
  offset: number
}

/**
 * A name the imports do not explain: a local variable, a method of a value a package returned, a
 * component imported through a local barrel. The type checker may resolve it to a package.
 */
export interface Candidate {
  offset: number
  kind: UsageKind
  props?: string[]
  spread?: boolean
}

/** What one file uses. */
export interface FileScan {
  sites: ScannedSite[]
  candidates: Candidate[]
  /** Set when the file could not be parsed. */
  problem?: string
}

interface Binding {
  package: string
  subpath: string
  /** `*` for a namespace import, `require()` or `import()` of the whole module. */
  export: string
  offset: number
  used: boolean
}

/** Nodes that wrap an expression without changing what it refers to. */
const transparent = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSNonNullExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
])

/** Keys that hold declared names rather than references, per node type. */
const declaredKeys: Record<string, string[]> = {
  FunctionDeclaration: ['id', 'params'],
  FunctionExpression: ['id', 'params'],
  ArrowFunctionExpression: ['params'],
  ClassDeclaration: ['id'],
  ClassExpression: ['id'],
  VariableDeclarator: ['id'],
  CatchClause: ['param'],
  LabeledStatement: ['label'],
  BreakStatement: ['label'],
  ContinueStatement: ['label'],
  TSInterfaceDeclaration: ['id'],
  TSTypeAliasDeclaration: ['id'],
  TSEnumDeclaration: ['id'],
  TSEnumMember: ['id'],
  TSModuleDeclaration: ['id'],
  TSTypeParameter: ['name'],
  TSImportEqualsDeclaration: ['id'],
  MetaProperty: ['meta', 'property'],
}

/** Keys that hold names of members, not references, unless the node is `computed`. */
const memberKeys: Record<string, string> = {
  MemberExpression: 'property',
  Property: 'key',
  MethodDefinition: 'key',
  PropertyDefinition: 'key',
  AccessorProperty: 'key',
  TSPropertySignature: 'key',
  TSMethodSignature: 'key',
  TSAbstractMethodDefinition: 'key',
  TSAbstractPropertyDefinition: 'key',
}

const maxMembers = 4

const languageOf = (file: string) =>
  /\.[mc]?tsx?$/.test(file) ? (file.endsWith('x') ? 'tsx' : 'ts') : 'jsx'

const memberText = (members: string[]) =>
  members.length ? members.slice(0, maxMembers).join('.').replaceAll('.()', '()') : undefined

const hasChildren = (element: Node) =>
  children(element, 'children').some(
    (item) => item.type !== 'JSXText' || (typeof item.value === 'string' && item.value.trim()),
  )

/**
 * Reads what one source file uses of packages: every import of `known` packages is followed to
 * the names that refer to it (aliases, namespace members, `require()` and `import()` results
 * included), and each reference becomes a site with how it is used, the member chain read from
 * it and, for JSX, the props passed. Shadowing of imported names by local ones is not tracked.
 * Names the imports do not explain come back as `candidates` for the type checker.
 */
export function scanFile(file: string, code: string, known: (name: string) => boolean): FileScan {
  let program: Node
  try {
    const result = parseSync(file, code, { lang: languageOf(file) })
    const parsed: unknown = result.program
    const [fatal] = result.errors
    if (!isNode(parsed) || (fatal && children(parsed, 'body').length === 0))
      return { sites: [], candidates: [], problem: fatal?.message ?? 'no program' }
    program = parsed
  } catch (error) {
    return {
      sites: [],
      candidates: [],
      problem: error instanceof Error ? error.message : String(error),
    }
  }

  const bindings = new Map<string, Binding>()
  const sites: ScannedSite[] = []
  const candidates: Candidate[] = []
  const parents = new Map<Node, Node>()

  const packageOf = (source: Node | undefined) => {
    const value = nameOf(source)
    const spec = value === undefined ? undefined : parseSpecifier(value)
    return spec && known(spec.name) ? spec : undefined
  }

  const bind = (local: Node | undefined, spec: PackageSpecifier, name: string) => {
    const localName = nameOf(local)
    if (!local || !localName) return
    bindings.set(localName, {
      package: spec.name,
      subpath: spec.subpath,
      export: name,
      offset: local.start,
      used: false,
    })
  }

  const site = (
    binding: Binding,
    offset: number,
    kind: UsageKind,
    extra: Partial<ScannedSite> = {},
  ) => {
    binding.used = true
    sites.push({
      package: binding.package,
      subpath: binding.subpath,
      export: binding.export,
      kind,
      offset,
      ...extra,
    })
  }

  /** `require('pkg')`, `import('pkg')` or `await import('pkg')`. */
  const moduleCall = (node: Node | undefined): PackageSpecifier | undefined => {
    let current = node
    while (current && (current.type === 'AwaitExpression' || transparent.has(current.type)))
      current = child(current, current.type === 'AwaitExpression' ? 'argument' : 'expression')
    if (!current) return undefined
    if (current.type === 'ImportExpression') return packageOf(child(current, 'source'))
    if (current.type === 'CallExpression' && nameOf(child(current, 'callee')) === 'require') {
      const [first] = children(current, 'arguments')
      return first?.type === 'Literal' ? packageOf(first) : undefined
    }
    return undefined
  }

  const bindPattern = (pattern: Node, spec: PackageSpecifier, base?: string) => {
    if (pattern.type === 'Identifier') {
      bind(pattern, spec, base ?? '*')
      return
    }
    if (pattern.type !== 'ObjectPattern') return
    for (const property of children(pattern, 'properties')) {
      if (property.type !== 'Property' || property.computed) continue
      const key = nameOf(child(property, 'key'))
      const value = child(property, 'value')
      const target = value?.type === 'AssignmentPattern' ? child(value, 'left') : value
      if (key && target?.type === 'Identifier') bind(target, spec, base ? base : key)
    }
  }

  const collect = (node: Node, parent?: Node) => {
    if (parent) parents.set(node, parent)
    if (node.type === 'ImportDeclaration') {
      const spec = packageOf(child(node, 'source'))
      if (!spec) return
      const specifiers = children(node, 'specifiers')
      if (!specifiers.length)
        sites.push({
          package: spec.name,
          subpath: spec.subpath,
          export: '*',
          kind: 'import',
          offset: child(node, 'source')?.start ?? node.start,
        })
      for (const specifier of specifiers) {
        const local = child(specifier, 'local')
        if (specifier.type === 'ImportDefaultSpecifier') bind(local, spec, 'default')
        else if (specifier.type === 'ImportNamespaceSpecifier') bind(local, spec, '*')
        else bind(local, spec, nameOf(child(specifier, 'imported')) ?? nameOf(local) ?? '*')
      }
      return
    }
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      const spec = packageOf(child(node, 'source'))
      if (spec) {
        if (node.type === 'ExportAllDeclaration')
          sites.push({
            package: spec.name,
            subpath: spec.subpath,
            export: '*',
            kind: 'reexport',
            offset: node.start,
          })
        for (const specifier of children(node, 'specifiers')) {
          const local = child(specifier, 'local')
          sites.push({
            package: spec.name,
            subpath: spec.subpath,
            export: nameOf(local) ?? '*',
            kind: 'reexport',
            offset: local?.start ?? specifier.start,
          })
        }
        return
      }
    }
    if (node.type === 'VariableDeclarator') {
      const id = child(node, 'id')
      const init = child(node, 'init')
      const spec = moduleCall(init)
      if (id && spec) bindPattern(id, spec)
    }
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) collect(item, node)
      } else if (isNode(value)) collect(value, node)
    }
  }
  collect(program)

  // `const { Button } = ui` reads exports out of a namespace binding.
  for (const [node, parent] of parents) {
    if (node.type !== 'VariableDeclarator' || parent.type !== 'VariableDeclaration') continue
    const init = child(node, 'init')
    const id = child(node, 'id')
    const source = init?.type === 'Identifier' ? bindings.get(nameOf(init) ?? '') : undefined
    if (!source || source.export !== '*' || id?.type !== 'ObjectPattern') continue
    source.used = true
    bindPattern(id, { name: source.package, subpath: source.subpath })
  }

  const parentOf = (node: Node) => {
    let parent = parents.get(node)
    while (parent && transparent.has(parent.type)) parent = parents.get(parent)
    return parent
  }

  const unwrap = (node: Node) => {
    let current = node
    while (transparent.has(current.type)) {
      const inner = child(current, 'expression')
      if (!inner) break
      current = inner
    }
    return current
  }

  const isSame = (outer: Node | undefined, inner: Node) =>
    outer !== undefined && unwrap(outer) === inner

  /** The identifier, `this` or other expression a chain of member reads and calls starts from. */
  const rootOf = (node: Node): Node | undefined => {
    let current: Node | undefined = node
    while (current) {
      if (current.type === 'MemberExpression') current = child(current, 'object')
      else if (current.type === 'CallExpression') current = child(current, 'callee')
      else if (transparent.has(current.type)) current = child(current, 'expression')
      else return current
    }
    return undefined
  }

  /**
   * Follows member reads and calls up from `start`: `useStore().reset()` from `useStore` gives
   * members `['()', 'reset']` ending in a call.
   */
  const chainOf = (start: Node) => {
    const members: string[] = []
    let expr = start
    let kind: UsageKind = 'reference'
    for (;;) {
      const parent = parentOf(expr)
      if (
        parent?.type === 'MemberExpression' &&
        isSame(child(parent, 'object'), expr) &&
        !parent.computed
      ) {
        const name = nameOf(child(parent, 'property'))
        if (!name) break
        members.push(name)
        expr = parent
        kind = 'member'
        continue
      }
      if (parent?.type === 'CallExpression' && isSame(child(parent, 'callee'), expr)) {
        const next = parentOf(parent)
        if (
          next?.type === 'MemberExpression' &&
          isSame(child(next, 'object'), parent) &&
          !next.computed
        ) {
          members.push('()')
          expr = parent
          continue
        }
        return { members, kind: 'call' as const, end: parent }
      }
      if (parent?.type === 'NewExpression' && isSame(child(parent, 'callee'), expr))
        return { members, kind: 'new' as const, end: parent }
      if (
        (parent?.type === 'ClassDeclaration' || parent?.type === 'ClassExpression') &&
        isSame(child(parent, 'superClass'), expr)
      )
        return { members, kind: 'extends' as const, end: parent }
      if (parent?.type === 'TSInterfaceHeritage' || parent?.type === 'TSClassImplements')
        return { members, kind: 'extends' as const, end: parent }
      break
    }
    return { members, kind, end: expr }
  }

  /** Sites of a binding's reference; a namespace's first member names the export. */
  const reference = (binding: Binding, identifier: Node) => {
    const chain = chainOf(identifier)
    let members = chain.members
    let target = binding
    if (binding.export === '*' && members[0] && members[0] !== '()') {
      target = { ...binding, export: members[0] }
      binding.used = true
      members = members.slice(1)
    }
    const end = parentOf(chain.end)
    const pattern =
      end?.type === 'VariableDeclarator' && isSame(child(end, 'init'), chain.end)
        ? child(end, 'id')
        : undefined
    if (pattern?.type === 'ObjectPattern') {
      if (target.export === '*' && chain.kind === 'reference' && !members.length) return
      const keys = children(pattern, 'properties').flatMap((property) =>
        property.type === 'Property' && !property.computed ? [nameOf(child(property, 'key'))] : [],
      )
      const base = chain.kind === 'call' ? [...members, '()'] : members
      for (const key of keys)
        if (key)
          site(target, identifier.start, 'member', { member: memberText([...base, key]) ?? key })
      if (keys.length) return
    }
    const member = memberText(members)
    const kind = members.length && chain.kind === 'reference' ? 'member' : chain.kind
    site(target, identifier.start, kind, member ? { member } : {})
  }

  /** Root identifier of a type name such as `ui.Props` and the names after it. */
  const typeName = (node: Node): { root: Node; rest: string[] } | undefined => {
    if (node.type === 'Identifier') return { root: node, rest: [] }
    if (node.type !== 'TSQualifiedName') return undefined
    const left = child(node, 'left')
    const inner = left ? typeName(left) : undefined
    const right = nameOf(child(node, 'right'))
    return inner && right ? { root: inner.root, rest: [...inner.rest, right] } : undefined
  }

  const typeReference = (name: Node) => {
    const parsed = typeName(name)
    if (!parsed) return
    const binding = bindings.get(nameOf(parsed.root) ?? '')
    if (!binding) {
      candidates.push({ offset: parsed.root.start, kind: 'type' })
      return
    }
    const [first, ...rest] = parsed.rest
    if (binding.export === '*' && first) {
      binding.used = true
      site(
        { ...binding, export: first },
        parsed.root.start,
        'type',
        rest.length ? { member: rest.join('.') } : {},
      )
      return
    }
    site(
      binding,
      parsed.root.start,
      'type',
      parsed.rest.length ? { member: parsed.rest.join('.') } : {},
    )
  }

  const jsx = (element: Node, opening: Node) => {
    const name = child(opening, 'name')
    if (!name) return
    const props: string[] = []
    let spread = false
    for (const attribute of children(opening, 'attributes')) {
      if (attribute.type === 'JSXSpreadAttribute') spread = true
      else {
        const attributeName = child(attribute, 'name')
        const text =
          attributeName?.type === 'JSXNamespacedName'
            ? `${nameOf(child(attributeName, 'namespace'))}:${nameOf(child(attributeName, 'name'))}`
            : nameOf(attributeName)
        if (text) props.push(text)
      }
    }
    if (hasChildren(element)) props.push('children')
    const extra = { ...(props.length ? { props } : {}), ...(spread ? { spread } : {}) }
    const path: Node[] = []
    let current: Node | undefined = name
    while (current?.type === 'JSXMemberExpression') {
      const property = child(current, 'property')
      if (property) path.unshift(property)
      current = child(current, 'object')
    }
    if (current?.type !== 'JSXIdentifier') return
    const rootName = nameOf(current) ?? ''
    const binding = bindings.get(rootName)
    if (!binding) {
      if (!/^[A-Z]/.test(rootName) && !path.length) return
      const last = path.at(-1) ?? current
      candidates.push({ offset: last.start, kind: 'jsx', ...extra })
      return
    }
    const names = path.map((node) => nameOf(node) ?? '')
    if (binding.export === '*' && names[0]) {
      binding.used = true
      const member = names.slice(1).join('.')
      site({ ...binding, export: names[0] }, current.start, 'jsx', {
        ...extra,
        ...(member ? { member } : {}),
      })
      return
    }
    site(binding, current.start, 'jsx', {
      ...extra,
      ...(names.length ? { member: names.join('.') } : {}),
    })
  }

  const isReference = (node: Node, parent: Node | undefined, key: string) => {
    if (!parent) return true
    if (declaredKeys[parent.type]?.includes(key)) return false
    if (
      memberKeys[parent.type] === key &&
      !parent.computed &&
      !(parent.type === 'Property' && parent.shorthand && key === 'value')
    )
      return false
    if (parent.type === 'ExportSpecifier' && key === 'exported') return false
    if (
      parent.type === 'ImportSpecifier' ||
      parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier'
    )
      return false
    return node.type === 'Identifier'
  }

  /** Visits a declared name's type annotations and default values, not the name itself. */
  const visitDeclared = (node: Node) => {
    if (node.type === 'Identifier') {
      const annotation = child(node, 'typeAnnotation')
      if (annotation) visit(annotation)
      return
    }
    if (node.type === 'AssignmentPattern') {
      const left = child(node, 'left')
      const right = child(node, 'right')
      if (left) visitDeclared(left)
      if (right) visit(right)
      return
    }
    if (node.type === 'ObjectPattern' || node.type === 'ArrayPattern') {
      for (const item of [...children(node, 'properties'), ...children(node, 'elements')]) {
        if (item.type === 'Property') {
          const key = child(item, 'key')
          if (item.computed && key) visit(key)
          const value = child(item, 'value')
          if (value) visitDeclared(value)
        } else visitDeclared(item)
      }
      const annotation = child(node, 'typeAnnotation')
      if (annotation) visit(annotation)
      return
    }
    if (node.type === 'RestElement') {
      const argument = child(node, 'argument')
      if (argument) visitDeclared(argument)
      return
    }
    if (node.type === 'TSParameterProperty') {
      const parameter = child(node, 'parameter')
      if (parameter) visitDeclared(parameter)
      return
    }
    visit(node)
  }

  const visit = (node: Node, parent?: Node, key = '') => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'JSXClosingElement':
        return
      case 'ExportNamedDeclaration':
        if (child(node, 'source')) return
        break
      case 'TSTypeReference': {
        const name = child(node, 'typeName')
        if (name) typeReference(name)
        const args = child(node, 'typeArguments')
        if (args) visit(args, node)
        return
      }
      case 'TSTypeQuery': {
        const name = child(node, 'exprName')
        if (name) typeReference(name)
        return
      }
      case 'JSXElement': {
        const opening = child(node, 'openingElement')
        if (opening) {
          jsx(node, opening)
          for (const attribute of children(opening, 'attributes')) visit(attribute, opening)
        }
        for (const item of children(node, 'children')) visit(item, node)
        return
      }
      case 'JSXAttribute': {
        const value = child(node, 'value')
        if (value) visit(value, node)
        return
      }
      case 'Identifier': {
        if (!isReference(node, parent, key)) return
        const name = nameOf(node) ?? ''
        const binding = bindings.get(name)
        if (parent?.type === 'ExportSpecifier' && binding) {
          site(binding, node.start, 'reexport')
          return
        }
        if (binding) {
          reference(binding, node)
          return
        }
        const chain = chainOf(node)
        candidates.push({ offset: node.start, kind: chain.members.length ? 'member' : chain.kind })
        return
      }
      case 'MemberExpression': {
        const property = child(node, 'property')
        const root = rootOf(node)
        if (
          property &&
          !node.computed &&
          !(root?.type === 'Identifier' && bindings.has(nameOf(root) ?? ''))
        ) {
          const next = parentOf(node)
          const called = (type: string) =>
            next?.type === type && isSame(child(next, 'callee'), node)
          candidates.push({
            offset: property.start,
            kind: called('CallExpression') ? 'call' : called('NewExpression') ? 'new' : 'member',
          })
        }
        break
      }
      default:
        break
    }
    const skip = declaredKeys[node.type]
    for (const childKey of Object.keys(node)) {
      if (childKey === 'type' || childKey === 'start' || childKey === 'end') continue
      const value = node[childKey]
      const declared = skip?.includes(childKey)
      const each = (item: Node) => (declared ? visitDeclared(item) : visit(item, node, childKey))
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) each(item)
      } else if (isNode(value)) each(value)
    }
  }
  visit(program)

  for (const binding of bindings.values())
    if (!binding.used)
      sites.push({
        package: binding.package,
        subpath: binding.subpath,
        export: binding.export,
        kind: 'import',
        offset: binding.offset,
      })

  return { sites, candidates }
}
