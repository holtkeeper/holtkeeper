import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isTestFile, listFiles } from '@holtkeeper/quality-tests'

import { bareName, createAttributeMatcher, createClassifier } from './classify.ts'
import type { TestAttribute, TestIdComponent, TestIdElement, TestIdsData } from './model.ts'
import { createResolver } from './resolve.ts'
import { builtinSources, type TemplateSource } from './sources.ts'
import type { TagAttribute } from './tags.ts'

/**
 * Test attributes and props of common setups: Testing Library, Cypress, QA teams, React Native.
 * Each also covers names extending it with `-`: `data-test` covers `data-test-id`, `data-test-state`.
 */
export const defaultAttributes: readonly string[] = [
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
  'testID',
  'testId',
]

/** Native tags users act on. */
export const defaultTags: readonly string[] = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
]

/** Events whose handlers turn any element or component into something a test clicks or types into. */
export const defaultEvents: readonly string[] = [
  'click',
  'dblclick',
  'doubleclick',
  'press',
  'longpress',
  'tap',
  'change',
  'input',
  'submit',
  'select',
  'toggle',
  'keydown',
  'keyup',
  'mousedown',
  'pointerdown',
]

/** ARIA roles of widgets. */
export const defaultRoles: readonly string[] = [
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'textbox',
  'searchbox',
  'combobox',
  'slider',
  'spinbutton',
  'treeitem',
]

/** Link targets and two-way bindings that make a component interactive. */
export const defaultMarkers: readonly string[] = [
  'href',
  'to',
  'routerLink',
  '[routerLink]',
  'v-model',
  '[(ngModel)]',
  'bind:value',
  'bind:checked',
  'bind:group',
]

/** Factories of styled components: linaria, styled-components, emotion, MUI, chakra, tailwind, framer-motion. */
export const defaultFactories: readonly string[] = ['styled', 'tw', 'chakra', 'motion']

/** Story, mock and fixture files hold no product UI. */
const SKIPPED =
  /(^|\/)(__mocks__|__fixtures__|mocks?|stories)\/|\.(stories|story|mock|fixture)\.[^/]+$/

const ELEMENTS_PER_FILE = 500

interface TemplateFilesOptions {
  dir: string
  sources?: readonly TemplateSource[]
  exclude?: readonly string[]
  signal?: AbortSignal
}

/** Template files a source reads, without tests, stories, mocks, fixtures and `exclude` matches. */
async function templateFiles(options: TemplateFilesOptions) {
  const sources = options.sources ?? Object.values(builtinSources)
  const all = await listFiles(options.dir)
  const excluded = (options.exclude ?? []).map((pattern) => new Bun.Glob(pattern))
  const templates = all.flatMap((file) => {
    if (isTestFile(file) || SKIPPED.test(file) || excluded.some((glob) => glob.match(file)))
      return []
    const source = sources.find((candidate) => candidate.matches(file))
    return source ? [{ file, source }] : []
  })
  return { all, templates }
}

export interface AnalyzeTestIdsOptions {
  dir: string
  /** Template sources; default `builtinSources` (`jsx`, `vue`, `svelte`, `html`). */
  sources?: readonly TemplateSource[]
  /** Test attribute names; each also covers names extending it with `-`. */
  attributes?: readonly string[]
  /** Glob patterns of files to leave out. */
  exclude?: readonly string[]
  signal?: AbortSignal
}

/** Component name of a template file: its base name, or its folder's for `index` and `+page`. */
export function componentName(file: string): string {
  const parts = file.split('/')
  const base = (parts.at(-1) ?? file).replace(/\.[^.]+$/, '').replace(/\.(component|page)$/, '')
  return /^(index|\+\w+)$/.test(base) && parts.length > 1 ? (parts.at(-2) ?? base) : base
}

const literal = (expression: string) => /^(['"`])([^'"`$\\]*)\1$/.exec(expression.trim())?.[2]

/** A scanned attribute as a catalog entry: literal values stay static, bindings are dynamic. */
function testAttribute(attribute: TagAttribute): TestAttribute {
  const name = bareName(attribute.name)
  const written = attribute.expression ?? attribute.value ?? ''
  const bound = attribute.expression !== undefined || name !== attribute.name
  if (!bound) return { name, value: written }
  const value = literal(written)
  return value === undefined ? { name, value: written, dynamic: true } : { name, value }
}

/**
 * Lists the test attributes a checkout's templates expose, per component (template file): every
 * element carrying an attribute from `attributes` or extending one with `-`, with its literal
 * value or, when set at runtime, the expression as written. Test, story and mock files are
 * skipped.
 */
export async function analyzeTestIds(options: AnalyzeTestIdsOptions): Promise<TestIdsData> {
  const attributes = options.attributes ?? defaultAttributes
  const match = createAttributeMatcher(attributes)
  const { templates } = await templateFiles(options)
  const components: TestIdComponent[] = []
  for (const { file, source } of templates) {
    options.signal?.throwIfAborted()
    // oxlint-disable-next-line no-await-in-loop
    const text = await readFile(join(options.dir, file), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    const elements: TestIdElement[] = []
    for (const tag of source.scan(text, file)) {
      const found = tag.attributes.filter((attribute) => match(attribute.name))
      if (found.length)
        elements.push({ line: tag.line, tag: tag.name, attributes: found.map(testAttribute) })
    }
    if (!elements.length) continue
    components.push({
      name: componentName(file),
      file,
      source: source.name,
      total: elements.length,
      elements: elements.slice(0, ELEMENTS_PER_FILE),
    })
  }
  return { attributes: [...attributes], components }
}

/** Import aliases from `compilerOptions.paths` of the root `tsconfig.json` or `jsconfig.json`. */
export async function tsconfigAliases(dir: string): Promise<Record<string, string>> {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    let config
    try {
      // oxlint-disable-next-line no-await-in-loop
      const text = await readFile(join(dir, name), 'utf8')
      config = JSON.parse(
        text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/,(\s*[}\]])/g, '$1'),
      )
    } catch {
      continue
    }
    const options = config?.compilerOptions ?? {}
    const base = typeof options.baseUrl === 'string' ? options.baseUrl : '.'
    const aliases: Record<string, string> = {}
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      const target = Array.isArray(targets) ? targets[0] : undefined
      if (typeof target !== 'string' || !pattern.endsWith('*') || !target.endsWith('*')) continue
      aliases[pattern.slice(0, -1)] = join(base, target.slice(0, -1)).replace(/^\.\//, '')
    }
    return aliases
  }
  return {}
}

/** An interactive element without a test attribute. */
export interface UntaggedElement {
  /** Relative to the checkout, `/`-separated. */
  file: string
  line: number
  /** As written, e.g. `Button`, `S.Submit`, `button`. */
  tag: string
  /** The native tag it renders, when it differs from `tag` and is known. */
  as?: string
  /** Why it counts as interactive, e.g. `button`, `click handler`, `role=tab`. */
  reason: string
  /** `unverified`: it spreads props that may carry a test id. */
  status: 'missing' | 'unverified'
}

export interface FindUntaggedOptions extends AnalyzeTestIdsOptions {
  tags?: readonly string[]
  events?: readonly string[]
  roles?: readonly string[]
  markers?: readonly string[]
  /** Tag or component names (`*` patterns) never reported, e.g. `Trans`. */
  ignore?: readonly string[]
  /** Component name (or `*` pattern) → the native tag it renders, e.g. `{ Button: 'button' }`. */
  components?: Readonly<Record<string, string>>
  factories?: readonly string[]
  /** Import prefix → folder; merged over `compilerOptions.paths` of the root `tsconfig.json`. */
  aliases?: Readonly<Record<string, string>>
}

/**
 * Finds interactive elements in a checkout's templates that carry no test attribute. Styled
 * components are followed to the native tag they render, across imports; components it cannot see
 * through count when they take an event handler, a role or a link. Elements that spread props are
 * `unverified` rather than `missing`. Test, story and mock files are skipped.
 */
export async function findUntagged(options: FindUntaggedOptions): Promise<UntaggedElement[]> {
  const { dir, signal } = options
  const classify = createClassifier({
    attributes: options.attributes ?? defaultAttributes,
    tags: options.tags ?? defaultTags,
    events: options.events ?? defaultEvents,
    roles: options.roles ?? defaultRoles,
    markers: options.markers ?? defaultMarkers,
    ignore: options.ignore ?? [],
  })
  const { all, templates } = await templateFiles(options)
  const texts = new Map<string, Promise<string | undefined>>()
  const read = (file: string) => {
    let text = texts.get(file)
    if (!text) {
      text = readFile(join(dir, file), 'utf8').catch(() => undefined)
      texts.set(file, text)
    }
    return text
  }
  const resolve = createResolver({
    files: new Set(all),
    read,
    factories: options.factories ?? defaultFactories,
    components: options.components ?? {},
    aliases: { ...(await tsconfigAliases(dir)), ...options.aliases },
  })

  const found: UntaggedElement[] = []
  for (const { file, source } of templates) {
    signal?.throwIfAborted()
    // oxlint-disable-next-line no-await-in-loop
    const text = await read(file)
    if (text === undefined) continue
    for (const tag of source.scan(text, file)) {
      // oxlint-disable-next-line no-await-in-loop
      const native = await resolve(tag.name, file)
      const result = classify(tag, native)
      if (!result || result.status === 'tagged') continue
      found.push({
        file,
        line: tag.line,
        tag: tag.name,
        ...(native && native !== tag.name ? { as: native } : {}),
        reason: result.reason,
        status: result.status,
      })
    }
  }
  texts.clear()
  return found
}
