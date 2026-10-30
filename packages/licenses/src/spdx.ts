/** A parsed SPDX license expression. */
export type LicenseNode =
  | { type: 'license'; id: string; plus: boolean; exception?: string }
  /** A license string that says nothing usable: `UNKNOWN`, `NOASSERTION`, or text that is not SPDX. */
  | { type: 'unknown'; text: string }
  | { type: 'and' | 'or'; items: LicenseNode[] }

/**
 * How a license fares against a policy, best first: `allowed`, `unknown` (nothing usable is
 * declared), `unlisted` (a known license the allow list does not contain), `denied`.
 */
export type LicenseVerdict = 'allowed' | 'unknown' | 'unlisted' | 'denied'

const order: readonly LicenseVerdict[] = ['denied', 'unlisted', 'unknown', 'allowed']
const rank = (verdict: LicenseVerdict) => order.indexOf(verdict)

/** Values registries and scanners use for "no license information". */
const unknownIds = new Set([
  'unknown',
  'noassertion',
  'none',
  'non-standard',
  'unlicensed',
  'see license in license',
  '',
])

const idPattern = /^(?:DocumentRef-[\w.-]+:)?[A-Za-z0-9][\w.-]*\+?$/

function tokenize(text: string): string[] {
  return text.match(/\(|\)|[^\s()]+/g) ?? []
}

/**
 * Parses an SPDX license expression (`MIT`, `MIT OR Apache-2.0`, `(A AND B) OR C`,
 * `GPL-2.0-only WITH Classpath-exception-2.0`, `GPL-2.0+`). Operators are matched without regard
 * to case, as registries often write them in lower case; `AND` binds tighter than `OR`. Text that
 * is not a valid expression, and the "no information" values, become an `unknown` node.
 */
export function parseLicense(text: string): LicenseNode {
  const raw = text.trim()
  if (unknownIds.has(raw.toLowerCase())) return { type: 'unknown', text: raw }
  const tokens = tokenize(raw)
  let index = 0
  const peek = () => tokens[index]?.toUpperCase()
  const fail = (): never => {
    throw new SyntaxError(raw)
  }

  const atom = (): LicenseNode => {
    const token = tokens[index++]
    if (token === undefined) return fail()
    if (token === '(') {
      const inner = or()
      if (tokens[index++] !== ')') fail()
      return inner
    }
    if (
      token === ')' ||
      ['AND', 'OR', 'WITH'].includes(token.toUpperCase()) ||
      !idPattern.test(token)
    )
      fail()
    if (unknownIds.has(token.toLowerCase())) return { type: 'unknown', text: token }
    const plus = token.endsWith('+')
    const node: LicenseNode = { type: 'license', id: plus ? token.slice(0, -1) : token, plus }
    if (peek() === 'WITH') {
      index++
      const exception = tokens[index++]
      if (!exception || !idPattern.test(exception)) fail()
      return { ...node, exception }
    }
    return node
  }
  const chain = (operator: 'AND' | 'OR', next: () => LicenseNode) => (): LicenseNode => {
    const items = [next()]
    while (peek() === operator) {
      index++
      items.push(next())
    }
    return items.length === 1 && items[0]
      ? items[0]
      : { type: operator === 'AND' ? 'and' : 'or', items }
  }
  const and = chain('AND', atom)
  const or = chain('OR', and)

  try {
    const node = or()
    if (index !== tokens.length) fail()
    return node
  } catch {
    return { type: 'unknown', text: raw }
  }
}

/** Canonical text of a node: ids as written, operators upper case, `AND`/`OR` operands sorted. */
export function formatLicense(node: LicenseNode, nested = false): string {
  if (node.type === 'unknown') return node.text || 'UNKNOWN'
  if (node.type === 'license')
    return `${node.id}${node.plus ? '+' : ''}${node.exception ? ` WITH ${node.exception}` : ''}`
  const text = node.items
    .map((item) => formatLicense(item, true))
    .toSorted((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .join(node.type === 'and' ? ' AND ' : ' OR ')
  return nested ? `(${text})` : text
}

/** Allowed and denied licenses: SPDX ids, ids with `*` wildcards (`GPL-*`), or whole expressions. */
export interface LicensePolicy {
  allow: readonly string[]
  deny: readonly string[]
}

interface CompiledList {
  patterns: RegExp[]
  expressions: Set<string>
}

const key = (node: LicenseNode) => formatLicense(node).toLowerCase()

function compile(entries: readonly string[]): CompiledList {
  const list: CompiledList = { patterns: [], expressions: new Set() }
  for (const entry of entries) {
    const trimmed = entry.trim()
    if (/^[\w.:*-]+\+?$/.test(trimmed)) {
      const source = trimmed
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\S*')
      list.patterns.push(new RegExp(`^${source}$`, 'i'))
    } else {
      const node = parseLicense(trimmed)
      if (node.type !== 'unknown') list.expressions.add(key(node))
    }
  }
  return list
}

const matches = (list: CompiledList, id: string) =>
  list.patterns.some((pattern) => pattern.test(id))

export interface Evaluation {
  verdict: LicenseVerdict
  /** The licenses responsible for a verdict other than `allowed`. */
  culprits: string[]
}

/** Compiles a policy once for many evaluations. */
export function licenseEvaluator(policy: LicensePolicy) {
  const allow = compile(policy.allow)
  const deny = compile(policy.deny)

  const evaluate = (node: LicenseNode): Evaluation => {
    const text = formatLicense(node)
    const exact = text.toLowerCase()
    if (deny.expressions.has(exact)) return { verdict: 'denied', culprits: [text] }
    if (allow.expressions.has(exact)) return { verdict: 'allowed', culprits: [] }

    if (node.type === 'unknown') return { verdict: 'unknown', culprits: [text] }
    if (node.type === 'license') {
      const ids = node.plus ? [`${node.id}+`, node.id] : [node.id]
      if (ids.some((id) => matches(deny, id))) return { verdict: 'denied', culprits: [text] }
      // `X+` means "X or any later version", so allowing X is enough.
      if (ids.some((id) => matches(allow, id))) return { verdict: 'allowed', culprits: [] }
      if (/^(?:DocumentRef-[^:]+:)?LicenseRef-/i.test(node.id))
        return { verdict: 'unknown', culprits: [text] }
      return { verdict: 'unlisted', culprits: [text] }
    }

    const results = node.items.map(evaluate)
    const pick = node.type === 'or' ? Math.max : Math.min
    const best = pick(...results.map((result) => rank(result.verdict)))
    const verdict = order[best] ?? 'unknown'
    if (verdict === 'allowed') return { verdict, culprits: [] }
    const culprits = (
      node.type === 'or' ? results : results.filter((result) => rank(result.verdict) === best)
    ).flatMap((result) => result.culprits)
    return { verdict, culprits: [...new Set(culprits)] }
  }

  /**
   * Evaluates the licenses declared for one package. Several declared licenses must all be
   * acceptable (they are combined with `AND`); none at all is `unknown`.
   */
  return (licenses: readonly string[]): Evaluation => {
    const nodes = licenses.map(parseLicense)
    if (nodes.length === 0) return { verdict: 'unknown', culprits: ['UNKNOWN'] }
    return evaluate(nodes.length === 1 && nodes[0] ? nodes[0] : { type: 'and', items: nodes })
  }
}

/** `licenseEvaluator(policy)` for a single evaluation. */
export const evaluateLicenses = (licenses: readonly string[], policy: LicensePolicy) =>
  licenseEvaluator(policy)(licenses)
