import { z } from 'zod'

import { eventOf } from './classify.ts'
import { defaultTags } from './defaults.ts'
import { type TestIdsData, attributeUsage } from './model.ts'
import type { TagAttribute } from './tags.ts'

/** How literal test id values are written: word separator, letter case and what they start with. */
export interface TestIdNaming {
  /** Between words: `-` (`save-button`), `_`, `.`, or `''` for camel and Pascal case. */
  separator: '-' | '_' | '.' | ''
  case: 'lower' | 'camel' | 'pascal'
  /**
   * What values start with: nothing, the component's name in the same style (`login-form-save`),
   * or the component's name as written followed by `separator` (`LoginForm-save`).
   */
  prefix: 'none' | 'component' | 'name'
}

/** What the catalog shows about a repository's test ids; derived, never configured. */
export interface LearnedTestIdOptions {
  /**
   * The id attribute: the most used configured or well-known id name (`data-testid`,
   * `data-test-id`, ...), preferring one with literal values; never a name extending one of them
   * (`data-test-state`) while such a name is in use.
   */
  attribute: string
  /** Every test attribute name in use, most used first. */
  attributes: string[]
  /** Native tags that carry ids in this repository; absent while the catalog is too small to tell. */
  elements?: string[]
  naming: TestIdNaming
  /** Up to three literal values of `attribute`. */
  examples: string[]
  /** Elements with test attributes in the catalog. */
  tagged: number
}

/** Tagged elements needed before learned `elements` replace the defaults. */
const MIN_ELEMENTS = 20

const kindOf = (tag: string) => {
  const name = (tag.split('.').at(-1) ?? tag).toLowerCase()
  return defaultTags.includes(name) ? name : undefined
}

/** Lower-case words of a name or value: `LoginForm` → `login form`, `save-button` → `save button`. */
const wordsOf = (text: string) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())

const separatorOf = (value: string): TestIdNaming['separator'] | undefined =>
  value.includes('-') ? '-' : value.includes('_') ? '_' : value.includes('.') ? '.' : undefined

/** The style of one value; `undefined` for a single lower-case word, which fits every style. */
function styleOf(value: string): Pick<TestIdNaming, 'separator' | 'case'> | undefined {
  const separator = separatorOf(value)
  if (separator) return { separator, case: 'lower' }
  if (/^[a-z][a-z0-9]*[A-Z]/.test(value)) return { separator: '', case: 'camel' }
  if (/^[A-Z][a-z0-9]+[A-Z]?/.test(value)) return { separator: '', case: 'pascal' }
  return undefined
}

function prefixOf(component: string, value: string): TestIdNaming['prefix'] {
  if (
    /^[A-Z]/.test(component) &&
    value.startsWith(component) &&
    /^[-_.]/.test(value.slice(component.length))
  )
    return 'name'
  const own = wordsOf(component)
  const words = wordsOf(value)
  return own.length && words.length > own.length && own.every((word, i) => words[i] === word)
    ? 'component'
    : 'none'
}

const majority = <T>(votes: readonly T[], key: (vote: T) => string): T | undefined => {
  const counts = new Map<string, { vote: T; count: number }>()
  for (const vote of votes) {
    const id = key(vote)
    const entry = counts.get(id) ?? { vote, count: 0 }
    entry.count++
    counts.set(id, entry)
  }
  return [...counts.values()].toSorted((a, b) => b.count - a.count)[0]?.vote
}

/** Names that hold ids in common setups, lower case. */
const ID_ATTRIBUTES = new Set([
  'data-testid',
  'data-test-id',
  'data-test',
  'data-qa',
  'data-cy',
  'testid',
])

/** Whether `name` is one of `configured` or a well-known id attribute, ignoring case. */
export const isIdAttribute = (name: string, configured: readonly string[]) =>
  ID_ATTRIBUTES.has(name.toLowerCase()) ||
  configured.some((item) => item.toLowerCase() === name.toLowerCase())

/**
 * The attribute of `usage` that holds ids: id attributes (`isIdAttribute`) before names merely
 * extending them, then ones with literal values, then the most used.
 */
export function idAttribute(
  usage: ReturnType<typeof attributeUsage>,
  configured: readonly string[],
): ReturnType<typeof attributeUsage>[number] | undefined {
  const rank = (entry: (typeof usage)[number]) =>
    (isIdAttribute(entry.name, configured) ? 2 : 0) + (entry.values.length ? 1 : 0)
  return usage.toSorted((a, b) => rank(b) - rank(a))[0]
}

/**
 * Learns the test id conventions of a repository from its catalog: the main attribute, every
 * attribute in use, the native tags that carry ids and how literal values are named.
 * `undefined` when the catalog has no element with a test attribute.
 */
export function learnTestIdOptions(data: TestIdsData): LearnedTestIdOptions | undefined {
  const usage = attributeUsage(data.components)
  const main = idAttribute(usage, data.attributes)
  if (!main) return undefined

  const kinds = new Set<string>()
  let tagged = 0
  const styles: Pick<TestIdNaming, 'separator' | 'case'>[] = []
  const prefixes: TestIdNaming['prefix'][] = []
  for (const component of data.components) {
    tagged += component.total
    const values: string[] = []
    for (const element of component.elements) {
      const kind = kindOf(element.tag)
      if (kind) kinds.add(kind)
      for (const attribute of element.attributes)
        if (attribute.name === main.name && !attribute.dynamic && attribute.value)
          values.push(attribute.value)
    }
    const own = majority(
      values.map((value) => {
        const prefix = prefixOf(component.name, value)
        const style = styleOf(prefix === 'name' ? value.slice(component.name.length + 1) : value)
        if (style) styles.push(style)
        return prefix
      }),
      (prefix) => prefix,
    )
    if (own) prefixes.push(own)
  }

  const style = majority(styles, (s) => `${s.separator}${s.case}`) ?? {
    separator: '-',
    case: 'lower',
  }
  const prefix = majority(prefixes, (p) => p) ?? 'none'
  const covered = prefixes.filter((p) => p === prefix).length * 2 >= prefixes.length
  return {
    attribute: main.name,
    attributes: usage.map((attribute) => attribute.name),
    ...(tagged >= MIN_ELEMENTS && kinds.size
      ? { elements: defaultTags.filter((tag) => kinds.has(tag)) }
      : {}),
    naming: { ...style, prefix: covered ? prefix : 'none' },
    examples: main.values.slice(0, 3),
    tagged,
  }
}

const list = (item: z.ZodString) =>
  z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : value,
    z.array(item),
  )

/**
 * What a team set for test ids in the `analyzers.testids` setting, on top of what was learned:
 * the attributes to use (new ids use the most used of them), the native tags that need one and files to
 * leave out.
 */
export const testIdOverridesSchema = z.object({
  attributes: list(z.string().min(1)).optional(),
  elements: list(z.string().min(1)).optional(),
  exclude: list(z.string().min(1)).optional(),
})

export type TestIdOverrides = z.output<typeof testIdOverridesSchema>

/** The overrides in a raw setting value; invalid or missing values give none. */
export function testIdOverridesOf(value: unknown): TestIdOverrides {
  const parsed = testIdOverridesSchema.safeParse(value)
  if (!parsed.success) return {}
  const { attributes, elements, exclude } = parsed.data
  return {
    ...(attributes?.length && { attributes }),
    ...(elements?.length && { elements }),
    ...(exclude?.length && { exclude }),
  }
}

/** The test id rules that apply: learned options with the team's overrides on top. */
export interface TestIdConvention {
  /** The attribute new ids use: the most used of the team's `attributes`, else the learned one. */
  attribute: string
  /** Attributes that count as a test id. */
  attributes: string[]
  /** Native tags that need an id; absent means the defaults (`defaultTags`). */
  elements?: string[]
  exclude: string[]
  naming: TestIdNaming
  examples: string[]
  /** Fields the team set: `attributes`, `elements`, `exclude`. */
  overridden: (keyof TestIdOverrides)[]
}

function conventionAttribute(
  configured: readonly string[],
  learned: LearnedTestIdOptions | undefined,
): string | undefined {
  const find = (name: string | undefined) =>
    name && configured.find((item) => item.toLowerCase() === name.toLowerCase())
  return find(learned?.attribute) || learned?.attributes.map(find).find(Boolean) || configured[0]
}

const fallbackNaming: TestIdNaming = { separator: '-', case: 'lower', prefix: 'none' }

/**
 * Merges learned options and overrides; overrides win field by field. With team `attributes`, new
 * ids use the one the repository uses most (the first one when it uses none). `undefined` when nothing
 * was learned and the team set no attribute either.
 */
export function testIdConvention(
  learned: LearnedTestIdOptions | undefined,
  overrides: TestIdOverrides = {},
): TestIdConvention | undefined {
  const attributes = overrides.attributes ?? learned?.attributes
  const attribute = overrides.attributes
    ? conventionAttribute(overrides.attributes, learned)
    : learned?.attribute
  if (!attributes?.length || !attribute) return undefined
  const elements = overrides.elements ?? learned?.elements
  return {
    attribute,
    attributes,
    ...(elements && { elements }),
    exclude: overrides.exclude ?? [],
    naming: learned?.naming ?? fallbackNaming,
    examples:
      overrides.attributes && attribute !== learned?.attribute ? [] : (learned?.examples ?? []),
    overridden: (['attributes', 'elements', 'exclude'] as const).filter(
      (key) => overrides[key] !== undefined,
    ),
  }
}

/** Attributes whose literal value names what an element is for, most telling first. */
const NAMING_ATTRIBUTES = ['name', 'aria-label', 'placeholder', 'title', 'alt', 'label', 'id']

const HANDLER_PREFIX = /^(?:handle|on)(?=[A-Z])/

const usable = (name: string) => !/^(?:e|event|_|async|await|function)$/.test(name)

function purposeOf(attributes: readonly TagAttribute[]): string[] {
  for (const key of NAMING_ATTRIBUTES) {
    const value = attributes.find((attribute) => attribute.name === key)?.value
    const words = value ? wordsOf(value).slice(0, 3) : []
    if (words.length) return words
  }
  for (const attribute of attributes) {
    if (!eventOf(attribute.name) || !attribute.expression) continue
    const called = [...attribute.expression.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].flatMap((match) =>
      match[1] && usable(match[1]) ? [match[1]] : [],
    )
    const name =
      called.at(-1) ?? (attribute.expression.match(/[A-Za-z_$][\w$]*/g) ?? []).findLast(usable)
    const words = name ? wordsOf(name.replace(HANDLER_PREFIX, '')).slice(0, 3) : []
    if (words.length) return words
  }
  const type = attributes.find((attribute) => attribute.name === 'type')?.value
  return type && !['button', 'submit', 'text'].includes(type) ? wordsOf(type) : []
}

const KIND_WORDS: Record<string, string> = { a: 'link', textarea: 'input', summary: 'toggle' }

function format(words: readonly string[], naming: TestIdNaming): string {
  if (naming.separator) return words.join(naming.separator)
  return words
    .map((word, i) =>
      i === 0 && naming.case === 'camel' ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join('')
}

/**
 * A test id for an element in the repository's naming style, from the component name, what the
 * element is for (its `name`, label or handler) and its kind: `login-form-save-button`. The same
 * input always gives the same id.
 */
export function suggestTestId(
  element: { tag: string; as?: string; attributes: readonly TagAttribute[] },
  component: string,
  naming: TestIdNaming,
): string {
  const native = element.as ?? kindOf(element.tag) ?? element.tag.split('.').at(-1) ?? element.tag
  const kind = KIND_WORDS[native] ?? native
  const written = element.tag.split('.').at(-1) ?? element.tag
  const own = purposeOf(element.attributes)
  const purpose = own.length || !/^[A-Z]/.test(written) ? own : wordsOf(written)
  const words = [...purpose, ...wordsOf(kind).filter((word) => !purpose.includes(word))]
  if (naming.prefix === 'component') words.unshift(...wordsOf(component))
  const body = format(
    words.filter((word, i) => word !== words[i - 1]),
    naming,
  )
  return naming.prefix === 'name' ? `${component}${naming.separator || '-'}${body}` : body
}

/** The convention as Markdown bullets for agents and people. */
export function renderTestIdConvention(convention: TestIdConvention): string {
  const team = (key: keyof TestIdOverrides) =>
    convention.overridden.includes(key) ? ' (set by the team)' : ''
  const naming = convention.naming
  const style = naming.separator
    ? `lower-case words joined by \`${naming.separator}\``
    : `${naming.case} case`
  const prefix =
    naming.prefix === 'component'
      ? ', starting with the component name in the same style'
      : naming.prefix === 'name'
        ? ', starting with the component name as written'
        : ''
  return [
    `- New ids use \`${convention.attribute}\`${team('attributes')}.`,
    ...(convention.attributes.length > 1
      ? [
          `- Attributes that count as a test id: ${convention.attributes.map((name) => `\`${name}\``).join(', ')}.`,
        ]
      : []),
    `- Elements that need one: ${(convention.elements ?? defaultTags).map((tag) => `\`${tag}\``).join(', ')}, plus anything with a click or change handler, a widget role or a link${team('elements')}.`,
    `- Values: ${style}${prefix}${convention.examples.length ? `, e.g. ${convention.examples.map((value) => `\`${value}\``).join(', ')}` : ''}.`,
    ...(convention.exclude.length
      ? [
          `- Files left out: ${convention.exclude.map((glob) => `\`${glob}\``).join(', ')}${team('exclude')}.`,
        ]
      : []),
  ].join('\n')
}
