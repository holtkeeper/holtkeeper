import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isTestFile, listFiles } from '@holtkeeper/quality-tests'

import { type ClassifyRules, createClassifier } from './classify.ts'
import type { MissingElement, TestIdFile, TestIdsData } from './model.ts'
import { createResolver } from './resolve.ts'
import { builtinSources, type TemplateSource } from './sources.ts'

/** Test id attributes and props of common setups: Testing Library, Cypress, QA teams, React Native. */
export const defaultAttributes: readonly string[] = [
  'data-testid',
  'data-test-id',
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

const ELEMENTS_PER_FILE = 200

export interface AnalyzeTestIdsOptions {
  dir: string
  /** Template sources; default `builtinSources` (`jsx`, `vue`, `svelte`, `html`). */
  sources?: readonly TemplateSource[]
  attributes?: readonly string[]
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
  /** Glob patterns of files to leave out. */
  exclude?: readonly string[]
  signal?: AbortSignal
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

/**
 * Finds interactive elements in a checkout's templates and whether each carries a test id.
 * Styled components are followed to the native tag they render, across imports; components it
 * cannot see through count when they take an event handler, a role or a link. Elements without
 * a test id that spread props are `unverified` rather than missing. Test, story and mock files
 * are skipped.
 */
export async function analyzeTestIds(options: AnalyzeTestIdsOptions): Promise<TestIdsData> {
  const { dir, signal } = options
  const sources = options.sources ?? Object.values(builtinSources)
  const attributes = options.attributes ?? defaultAttributes
  const rules: ClassifyRules = {
    attributes,
    tags: options.tags ?? defaultTags,
    events: options.events ?? defaultEvents,
    roles: options.roles ?? defaultRoles,
    markers: options.markers ?? defaultMarkers,
    ignore: options.ignore ?? [],
  }
  const classify = createClassifier(rules)

  const all = await listFiles(dir)
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

  const excluded = (options.exclude ?? []).map((pattern) => new Bun.Glob(pattern))
  const usage: Record<string, number> = Object.fromEntries(attributes.map((name) => [name, 0]))
  const files: TestIdFile[] = []
  for (const file of all) {
    signal?.throwIfAborted()
    if (isTestFile(file) || SKIPPED.test(file) || excluded.some((glob) => glob.match(file)))
      continue
    const source = sources.find((candidate) => candidate.matches(file))
    if (!source) continue
    // oxlint-disable-next-line no-await-in-loop
    const text = await read(file)
    if (text === undefined) continue
    const entry: TestIdFile = {
      file,
      source: source.name,
      total: 0,
      tagged: 0,
      unverified: 0,
      elements: [],
    }
    const elements: MissingElement[] = []
    for (const tag of source.scan(text, file)) {
      // oxlint-disable-next-line no-await-in-loop
      const native = await resolve(tag.name, file)
      const result = classify(tag, native)
      if (!result) continue
      entry.total++
      if (result.status === 'tagged') {
        entry.tagged++
        if (result.attribute) usage[result.attribute] = (usage[result.attribute] ?? 0) + 1
        continue
      }
      if (result.status === 'unverified') entry.unverified++
      elements.push({
        line: tag.line,
        tag: tag.name,
        ...(native && native !== tag.name ? { as: native } : {}),
        reason: result.reason,
        status: result.status,
      })
    }
    if (!entry.total) continue
    entry.elements = elements
      .toSorted((a, b) =>
        a.status === b.status ? a.line - b.line : a.status === 'missing' ? -1 : 1,
      )
      .slice(0, ELEMENTS_PER_FILE)
    files.push(entry)
  }
  texts.clear()
  return { attributes: [...attributes], files, usage }
}
