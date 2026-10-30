import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import {
  type AnalysisLayer,
  analyzeCatalogs,
  type FillMode,
  type LocalePolicy,
  type WriteRule,
} from './analyze.ts'
import {
  type CatalogFile,
  type CatalogFiles,
  chooseBaseLocale,
  configBaseLocale,
  detectCatalogs,
  diskCatalogFiles,
} from './detect.ts'
import {
  compileTemplate,
  isExternal,
  layerCatalogs,
  type LayerSpec,
  parseRepo,
  templateVars,
} from './layers.ts'
import { requiredCheckouts } from './layers.ts'
import { i18nAnalysis } from './report.ts'
import { defaultSources } from './sources/index.ts'
import type { CatalogSource, ChangeTarget, DynamicUsage, I18nData, KeyUsage } from './types.ts'
import {
  DEFAULT_FUNCTIONS,
  isSourceFile,
  parsePattern,
  scanSource,
  type UsagePattern,
} from './usage.ts'

export interface AnalyzeI18nOptions {
  /** The analyzed repository: its source code is scanned, and it fills `{repo}` placeholders. */
  repo: ChangeTarget
  code: CatalogFiles
  /** Catalog layers; when absent, catalogs are auto-detected in `code`. */
  layers?: readonly LayerSpec[]
  /** Files of other repositories by `forge:path`, for layers with a `repo`. */
  checkouts?: Readonly<Record<string, CatalogFiles>>
  write?: readonly WriteRule[]
  locales?: LocalePolicy & { base?: string }
  mode?: 'report' | 'suggest'
  sources?: readonly CatalogSource[]
  functions?: readonly string[]
  ignoreKeys?: readonly string[]
  fill?: FillMode
  marker?: string
  log?: (line: string) => void
}

const MAX_SOURCE_BYTES = 1024 * 1024

/** Reads catalogs (layered or auto-detected), scans code for translation calls and compares them. */
export async function analyzeI18n(options: AnalyzeI18nOptions): Promise<I18nData> {
  const { code, repo } = options
  const sources = options.sources ?? defaultSources()
  const files: CatalogFile[] = []
  const layers: AnalysisLayer[] = []
  const errors: { file: string; message: string }[] = []

  if (options.layers?.length) {
    const vars = templateVars(repo.path)
    const ids = new Set<string>()
    for (const spec of options.layers) {
      if (ids.has(spec.id)) throw new Error(`duplicate i18n layer id "${spec.id}"`)
      ids.add(spec.id)
      const external = isExternal(spec, repo)
      const store = external ? options.checkouts?.[spec.repo!] : code
      if (!store) throw new Error(`i18n layer "${spec.id}" needs a checkout of ${spec.repo}`)
      const found = await layerCatalogs(spec, store, vars, sources)
      files.push(...found.files)
      errors.push(...found.errors)
      const target = external ? parseRepo(spec.repo!) : undefined
      layers.push({
        info: {
          id: spec.id,
          ...(target ? { repo: target } : {}),
          ...(spec.ref ? { ref: spec.ref } : {}),
          files: spec.files,
          shared: external && !/\{repo(Name)?\}/.test(spec.files),
          catalogs: found.files.length,
        },
        ...(target ? { target } : {}),
        template: compileTemplate(spec.files, vars),
      })
    }
    for (const rule of options.write ?? [])
      if (!ids.has(rule.layer))
        throw new Error(`i18n write rule names unknown layer "${rule.layer}"`)
  } else {
    const detected = await detectCatalogs({ files: code, sources })
    files.push(...detected.files)
    errors.push(...detected.errors)
  }
  for (const error of errors) options.log?.(`i18n: skipped ${error.file}: ${error.message}`)

  const baseLocale = chooseBaseLocale(files, options.locales?.base, await configBaseLocale(code))
  const patterns = (options.functions?.length ? options.functions : DEFAULT_FUNCTIONS).flatMap(
    (spec) => {
      const pattern = parsePattern(spec)
      return pattern ? [pattern] : []
    },
  ) satisfies UsagePattern[]
  const localLayers = new Set([
    'local',
    ...layers.filter((l) => !l.info.shared).map((l) => l.info.id),
  ])
  const catalogPaths = new Set(files.filter((f) => localLayers.has(f.layer)).map((f) => f.file))
  const keys: KeyUsage[] = []
  const dynamic: DynamicUsage[] = []
  let scanned = 0
  for (const file of await code.list()) {
    if (!isSourceFile(file) || catalogPaths.has(file)) continue
    const text = await code.read(file)
    if (text === undefined || text.length > MAX_SOURCE_BYTES) continue
    scanned++
    try {
      const found = scanSource(file, text, patterns)
      keys.push(...found.keys)
      dynamic.push(...found.dynamic)
    } catch (error) {
      options.log?.(
        `i18n: could not scan ${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const { base: _base, ...policy } = options.locales ?? {}
  return analyzeCatalogs({
    files,
    baseLocale,
    ...(layers.length ? { layers } : {}),
    ...(options.write ? { write: options.write } : {}),
    locales: policy,
    ...(options.mode ? { mode: options.mode } : {}),
    usage: { files: scanned, keys, dynamic },
    ...(options.ignoreKeys ? { ignoreKeys: options.ignoreKeys } : {}),
    ...(options.fill ? { fill: options.fill } : {}),
    ...(options.marker !== undefined ? { marker: options.marker } : {}),
  })
}

const list = z
  .union([z.array(z.string()), z.string().transform((text) => text.split(','))])
  .transform((items) => items.map((s) => s.trim()).filter(Boolean))

const checkouts = z
  .union([z.record(z.string(), z.string()), list])
  .transform((value): Record<string, string> => {
    if (!Array.isArray(value)) return value
    const map: Record<string, string> = {}
    for (const item of value) {
      const eq = item.lastIndexOf('=')
      if (eq <= 0) throw new Error(`expected "forge:path=/abs/dir", got "${item}"`)
      map[item.slice(0, eq)] = item.slice(eq + 1)
    }
    return map
  })

/** Options of the `i18n` analyzer. */
export const i18nOptions = z.object({
  /** `report` only shows findings; `suggest` also produces changes. */
  mode: z.enum(['report', 'suggest']).default('report'),
  locales: z
    .object({
      base: z.string().optional(),
      required: list.optional(),
      optional: list.optional(),
      ignore: list.optional(),
    })
    .optional(),
  /** Flat alias of `locales.base` for the command line. */
  baseLocale: z.string().optional(),
  /** Merged in order; later layers override earlier ones. Omitted: auto-detect in the checkout. */
  layers: z
    .array(
      z.object({
        id: z.string().min(1),
        repo: z
          .string()
          .regex(/^[^:]+:.+$/, 'expected "forge:path"')
          .optional(),
        ref: z.string().optional(),
        files: z.string().min(1),
        format: z.enum(['json', 'yaml', 'po', 'properties', 'auto']).optional(),
        namespace: z.string().optional(),
      }),
    )
    .optional(),
  /** Where missing keys go; first matching rule wins; default the last layer having the namespace. */
  write: z
    .array(
      z.object({ keys: list.optional(), namespaces: list.optional(), layer: z.string().min(1) }),
    )
    .optional(),
  functions: list.optional(),
  ignoreKeys: list.optional(),
  fill: z.enum(['base', 'empty', 'todo']).default('todo'),
  marker: z.string().default('TODO: '),
  /**
   * Checkouts of the layers' repositories, `{ 'forge:path': '/abs/dir' }`, provided by the runner
   * for every entry of `requiredCheckouts`; `--checkout forge:path=/abs/dir` on the command line.
   */
  __checkouts: checkouts.optional(),
})

export type I18nOptions = z.infer<typeof i18nOptions>

/**
 * The `i18n` analyzer: translation gaps of one repository. Layers may live in other repositories
 * (a shared translations repository with common and per-project folders): runners check out every
 * repository `requiredCheckouts(options, repo)` (from `layers.ts`) lists and pass the directories in `__checkouts`.
 * Source code is always scanned in the analyzed checkout.
 */
export const i18nAnalyzer = defineAnalyzer<I18nData, I18nOptions>({
  kind: 'i18n',
  analysis: i18nAnalysis,
  scope: 'repo',
  needs: { checkout: true },
  options: i18nOptions,
  requiredCheckouts: (options, repo) => requiredCheckouts(options, repo),
  flags: [
    {
      flag: 'mode',
      option: 'mode',
      description: 'report (default) or suggest, which also proposes changes',
    },
    { flag: 'base-locale', option: 'baseLocale', description: 'base locale (default: detected)' },
    {
      flag: 'functions',
      option: 'functions',
      description: 'comma-separated translation calls, e.g. "t,<Trans i18nKey>"',
    },
    {
      flag: 'ignore-keys',
      option: 'ignoreKeys',
      description: 'comma-separated globs of keys to skip',
    },
    { flag: 'fill', option: 'fill', description: 'added keys: todo (default), base or empty' },
    {
      flag: 'checkout',
      option: '__checkouts',
      description: 'forge:path=/abs/dir of a layer repository (comma-separated for several)',
    },
  ],
  async run({ repo, dir, ref, options, log, checkouts: provided }) {
    if (!dir) throw new Error('the i18n analyzer needs a checkout')
    const stores: Record<string, CatalogFiles> = {}
    // The task engine passes the repositories `requiredCheckouts` asked for here; the CLI uses `__checkouts`.
    for (const [key, path] of Object.entries(provided ?? {})) stores[key] = diskCatalogFiles(path)
    // oxlint-disable-next-line no-underscore-dangle -- runner-provided option, named so it cannot clash with user config
    for (const [key, path] of Object.entries(options.__checkouts ?? {}))
      stores[key] = diskCatalogFiles(path)
    const base = options.locales?.base ?? options.baseLocale
    const data = await analyzeI18n({
      repo,
      code: diskCatalogFiles(dir),
      ...(options.layers ? { layers: options.layers } : {}),
      checkouts: stores,
      ...(options.write ? { write: options.write } : {}),
      locales: { ...options.locales, ...(base ? { base } : {}) },
      mode: options.mode,
      ...(options.functions ? { functions: options.functions } : {}),
      ...(options.ignoreKeys ? { ignoreKeys: options.ignoreKeys } : {}),
      fill: options.fill,
      marker: options.marker,
      ...(log ? { log } : {}),
    })
    return { data, ...(ref ? { ref } : {}) }
  },
})
