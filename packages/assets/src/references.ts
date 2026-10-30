import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Asset } from './data.ts'
import { defaultIgnore, scanFiles } from './inventory.ts'

/** Files searched for asset names: code, markup, styles and configs. */
const sourcePatterns = [
  '**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue,svelte,astro,html,htm,css,scss,sass,less,styl}',
  '**/*.{json,json5,yml,yaml,toml,xml,plist,webmanifest,ini,cfg,txt}',
  '**/*.{tscn,tres,scene,prefab,fire,lua,gd,cs,py}',
]

/** Folders whose files are generated and would mention every asset they bundle. */
export const generatedIgnore = [
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.next/**',
  '**/*.min.js',
  '**/package-lock.json',
  '**/bun.lock',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
]

/** Loaded by browsers and platforms by convention, so they are never reported as unused. */
const implicit =
  /^(?:favicon|apple-touch-icon|android-chrome|mstile|safari-pinned-tab|browserconfig|robots|og-image|social)[\w.-]*$/i

const MAX_SOURCE_BYTES = 2 * 1024 * 1024

/** The set of identifiers and paths mentioned in `text`, plus the last segment of each path. */
export function tokensOf(text: string, into = new Set<string>()): Set<string> {
  for (const match of text.matchAll(/[\w@.\-/\\]+/g)) {
    const token = match[0].replaceAll('\\', '/').toLowerCase()
    into.add(token)
    const slash = token.lastIndexOf('/')
    if (slash !== -1 && slash < token.length - 1) into.add(token.slice(slash + 1))
  }
  return into
}

/**
 * Whether an asset looks referenced: its file name, its path without extension, or (for stems of
 * three or more characters) its bare stem appears as a token. Deliberately lenient — loaders often
 * use keys like `'hero'` for `hero.png` — so a miss is a strong hint, not proof.
 */
export function isReferenced(path: string, tokens: ReadonlySet<string>): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (implicit.test(name)) return true
  if (tokens.has(name)) return true
  const stem = name.replace(/\.[^.]+$/, '')
  if (stem.length >= 3 && tokens.has(stem)) return true
  const parts = path.toLowerCase().split('/')
  for (let start = 1; start < parts.length; start++) {
    const suffix = parts.slice(start).join('/')
    if (tokens.has(suffix)) return true
    if (start < parts.length - 1 && tokens.has(suffix.replace(/\.[^./]+$/, ''))) return true
  }
  return false
}

/**
 * Tokens of every source and config file of the repository plus the given extra texts (atlases,
 * glTF), for `isReferenced`. Generated folders and files over 2 MB are skipped.
 */
export async function collectTokens(
  dir: string,
  extra: readonly string[] = [],
  ignore: readonly string[] = [],
): Promise<Set<string>> {
  const tokens = new Set<string>()
  const files = await scanFiles(dir, sourcePatterns, [
    ...defaultIgnore,
    ...generatedIgnore,
    ...ignore,
  ])
  for (const file of files) {
    const content = await readFile(join(dir, file))
    if (content.byteLength > MAX_SOURCE_BYTES) continue
    tokensOf(content.toString('utf8'), tokens)
  }
  for (const text of extra) tokensOf(text, tokens)
  return tokens
}

/** Marks source assets with `referenced`; build outputs are left unchecked. */
export function markReferences(assets: Asset[], tokens: ReadonlySet<string>): Asset[] {
  return assets.map((asset) =>
    asset.origin === 'source' ? { ...asset, referenced: isReferenced(asset.path, tokens) } : asset,
  )
}
