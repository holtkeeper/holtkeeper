import type { ScannedTag, TagAttribute } from './tags.ts'

/** What makes an element interactive and what counts as its test id. */
export interface ClassifyRules {
  /** Test attribute names and prefixes (see `createAttributeMatcher`). */
  attributes: readonly string[]
  /** Native tags that are interactive by themselves. */
  tags: readonly string[]
  /** Events whose handlers make any element interactive, lower-case without `on`: `click`. */
  events: readonly string[]
  /** ARIA roles that make any element interactive. */
  roles: readonly string[]
  /** Attributes that make a component (or `a`) interactive: links, two-way bindings. */
  markers: readonly string[]
  /** Tag or component names (`*` patterns) never reported. */
  ignore: readonly string[]
}

/** One interactive element and whether it carries a test id. */
export interface Classified {
  status: 'tagged' | 'missing' | 'unverified'
  /** Why it counts as interactive: `button`, `click handler`, `role=tab`, `href`. */
  reason: string
  /** The configured test attribute that matched (for `tagged`). */
  attribute?: string
}

/** Attribute name without binding syntax: `:data-testid`, `v-bind:x`, `[attr.x]`, `[x]` → `x`. */
export function bareName(name: string): string {
  let bare = name
  if (bare.startsWith('[') && bare.endsWith(']')) bare = bare.slice(1, -1)
  if (bare.startsWith('attr.')) bare = bare.slice(5)
  if (bare.startsWith('v-bind:')) bare = bare.slice(7)
  else if (bare.startsWith(':')) bare = bare.slice(1)
  return bare.replace(/\.(prop|camel|attr)$/, '')
}

/** The event an attribute handles, lower-case: `onClick`, `@click.stop`, `v-on:click`, `on:click`, `(click)`, `onclick`. */
export function eventOf(name: string): string | undefined {
  const jsx = /^on([A-Z][A-Za-z]*)$/.exec(name)
  if (jsx?.[1]) return jsx[1].toLowerCase()
  const directive = /^(?:@|v-on:|on:)([\w-]+)/.exec(name)
  if (directive?.[1]) return directive[1].toLowerCase()
  const angular = /^\(([\w.-]+)\)$/.exec(name)
  if (angular?.[1]) return angular[1].split('.')[0]?.toLowerCase()
  const html = /^on([a-z]+)$/.exec(name)
  return html?.[1]
}

/**
 * Matches attribute names against configured test attributes: a name counts when its bare name
 * (binding syntax stripped) equals a configured one or extends it with `-`, case-insensitively, so
 * `data-test` covers `data-test-id` and `data-test-state`. Returns the configured name that matched.
 */
export function createAttributeMatcher(attributes: readonly string[]) {
  const exact = new Set(attributes)
  const lower = attributes.map((name) => [name.toLowerCase(), name] as const)
  return (name: string): string | undefined => {
    const bare = bareName(name)
    if (exact.has(bare)) return bare
    const key = bare.toLowerCase()
    return lower.find(([prefix]) => key === prefix || key.startsWith(`${prefix}-`))?.[1]
  }
}

/** `v-bind="$attrs"` and `v-bind="props"` bind a whole object, like a JSX spread. */
const isSpread = (attribute: TagAttribute) => attribute.name === 'v-bind'

const matcher = (patterns: readonly string[]) => {
  const regexes = patterns.map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`,
      ),
  )
  return (name: string) => regexes.some((regex) => regex.test(name))
}

/**
 * Builds the classifier for `rules`. It takes a tag and the native tag it renders (`undefined`
 * for components it could not resolve) and returns `undefined` for elements that are not
 * interactive.
 */
export function createClassifier(rules: ClassifyRules) {
  const testAttribute = createAttributeMatcher(rules.attributes)
  const tags = new Set(rules.tags)
  const events = new Set(rules.events)
  const roles = new Set(rules.roles)
  const markers = new Set(rules.markers)
  const ignored = matcher(rules.ignore)

  const reasonOf = (tag: ScannedTag, native: string | undefined) => {
    if (native && tags.has(native)) {
      const type = tag.attributes.find((a) => a.name === 'type')?.value
      if (native === 'input' && type === 'hidden') return undefined
      return native
    }
    for (const attribute of tag.attributes) {
      const event = eventOf(attribute.name)
      if (event && events.has(event)) return `${event} handler`
      if (bareName(attribute.name) === 'role' && attribute.value && roles.has(attribute.value))
        return `role=${attribute.value}`
      if (/^contenteditable$/i.test(attribute.name) && attribute.value !== 'false')
        return 'contenteditable'
      if (/^tabindex$/i.test(bareName(attribute.name)) && attribute.value !== '-1')
        return 'tabindex'
      if ((native === undefined || native === 'a') && markers.has(attribute.name))
        return attribute.name
    }
    return undefined
  }

  return (tag: ScannedTag, native: string | undefined): Classified | undefined => {
    if (ignored(tag.name)) return undefined
    const reason = reasonOf(tag, native)
    if (!reason) return undefined
    for (const attribute of tag.attributes) {
      const configured = testAttribute(attribute.name)
      if (configured) return { status: 'tagged', reason, attribute: configured }
    }
    const spread = tag.spread || tag.attributes.some(isSpread)
    return { status: spread ? 'unverified' : 'missing', reason }
  }
}
