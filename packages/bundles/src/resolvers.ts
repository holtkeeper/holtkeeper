import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

import type { Entrypoint, EntrypointResolver } from './entrypoints.ts'
import { entryNameOf, listFiles, scanImports, toDistPath } from './files.ts'
import { normalizeAssetName } from './names.ts'

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

interface ViteChunk {
  file: string
  name?: string
  src?: string
  isEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
}

/**
 * Entrypoints from a Vite or Rollup build manifest (`build.manifest: true`): every `isEntry`
 * chunk with its CSS and static imports; dynamic imports become lazy assets.
 */
export function viteManifestResolver(options: { paths?: string[] } = {}): EntrypointResolver {
  const paths = options.paths ?? ['.vite/manifest.json', 'manifest.json']
  return {
    name: 'vite-manifest',
    tool: 'vite',
    async resolve(distDir) {
      for (const path of paths) {
        const manifest = await readJson(join(distDir, path))
        if (!isRecord(manifest)) continue
        const chunks = new Map<string, ViteChunk>()
        for (const [key, value] of Object.entries(manifest)) {
          if (!isRecord(value) || typeof value.file !== 'string') continue
          chunks.set(key, {
            file: value.file,
            ...(typeof value.name === 'string' ? { name: value.name } : {}),
            ...(typeof value.src === 'string' ? { src: value.src } : {}),
            isEntry: value.isEntry === true,
            imports: strings(value.imports),
            dynamicImports: strings(value.dynamicImports),
            css: strings(value.css),
          })
        }
        if (!chunks.size) continue
        const files = new Set(await listFiles(distDir))

        const collect = (keys: Iterable<string>, into: Set<string>, dynamic: Set<string>) => {
          const seen = new Set<string>()
          const queue = [...keys]
          for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
            const chunk = chunks.get(key)
            if (!chunk || seen.has(key)) continue
            seen.add(key)
            into.add(chunk.file)
            for (const css of strings(chunk.css)) into.add(css)
            queue.push(...strings(chunk.imports))
            for (const target of strings(chunk.dynamicImports)) dynamic.add(target)
          }
        }

        const entrypoints: Entrypoint[] = []
        for (const [key, chunk] of chunks) {
          if (!chunk.isEntry) continue
          const initial = new Set<string>()
          const src = chunk.src ?? key
          if (/\.html?$/.test(src) && files.has(src)) initial.add(src)
          const pending = new Set<string>()
          collect([key], initial, pending)
          const lazy = new Set<string>()
          const done = new Set<string>()
          while (pending.size) {
            const next = [...pending].filter((target) => !done.has(target))
            pending.clear()
            for (const target of next) done.add(target)
            collect(next, lazy, pending)
          }
          entrypoints.push({
            name: chunk.name && !/\.html?$/.test(src) ? chunk.name : entryNameOf(src),
            initial: [...initial],
            lazy: [...lazy].filter((file) => !initial.has(file)),
          })
        }
        if (entrypoints.length) return entrypoints
      }
      return undefined
    },
  }
}

/**
 * Entrypoints from webpack's `stats.json` (`entrypoints` with their assets; lazy chunks through
 * chunk `children`) or from a `asset-manifest.json` with an `entrypoints` list (Create React App).
 */
export function webpackStatsResolver(options: { paths?: string[] } = {}): EntrypointResolver {
  const paths = options.paths ?? ['stats.json', 'asset-manifest.json']
  return {
    name: 'webpack-stats',
    tool: 'webpack',
    async resolve(distDir) {
      const files = new Set(await listFiles(distDir))
      const toFile = (ref: string) => toDistPath(ref, '', files)
      for (const path of paths) {
        const stats = await readJson(join(distDir, path))
        if (!isRecord(stats)) continue

        if (Array.isArray(stats.entrypoints)) {
          const initial = strings(stats.entrypoints).flatMap((ref) => toFile(ref) ?? [])
          if (initial.length) return [{ name: 'main', initial, lazy: [] }]
          continue
        }
        if (!isRecord(stats.entrypoints)) continue

        const chunks = new Map<string, { files: string[]; children: string[] }>()
        for (const chunk of Array.isArray(stats.chunks) ? stats.chunks : []) {
          if (!isRecord(chunk)) continue
          chunks.set(String(chunk.id), {
            files: strings(chunk.files),
            children: Array.isArray(chunk.children) ? chunk.children.map(String) : [],
          })
        }
        const assetNames = (value: unknown) =>
          (Array.isArray(value) ? value : []).flatMap((asset) => {
            const ref = typeof asset === 'string' ? asset : isRecord(asset) ? asset.name : undefined
            return typeof ref === 'string' && !ref.endsWith('.map') ? (toFile(ref) ?? []) : []
          })

        const entrypoints: Entrypoint[] = []
        for (const [name, entry] of Object.entries(stats.entrypoints)) {
          if (!isRecord(entry)) continue
          const initial = new Set(assetNames(entry.assets))
          const entryChunks = Array.isArray(entry.chunks) ? entry.chunks.map(String) : []
          const lazy = new Set<string>()
          const seen = new Set(entryChunks)
          const queue = entryChunks.flatMap((id) => chunks.get(id)?.children ?? [])
          for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
            if (seen.has(id)) continue
            seen.add(id)
            const chunk = chunks.get(id)
            if (!chunk) continue
            for (const file of chunk.files) {
              const resolved = toFile(file)
              if (resolved && !resolved.endsWith('.map') && !initial.has(resolved))
                lazy.add(resolved)
            }
            queue.push(...chunk.children)
          }
          if (initial.size) entrypoints.push({ name, initial: [...initial], lazy: [...lazy] })
        }
        if (entrypoints.length) return entrypoints
      }
      return undefined
    },
  }
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
    .exec(tag)
    ?.slice(1)
    .find((value) => value !== undefined)

/**
 * One entrypoint per HTML page in the build: the page itself, its `<script src>`, stylesheets and
 * `modulepreload`/`preload` links. Inline scripts and module imports are followed by `followImports`.
 */
export function htmlResolver(options: { globs?: string[] } = {}): EntrypointResolver {
  const globs = (options.globs ?? ['**/*.html']).map((glob) => new Bun.Glob(glob))
  return {
    name: 'html',
    async resolve(distDir) {
      const all = await listFiles(distDir)
      const files = new Set(all)
      const pages = all.filter((file) => globs.some((glob) => glob.match(file)))
      const entrypoints: Entrypoint[] = []
      for (const page of pages) {
        const html = await readFile(join(distDir, page), 'utf8')
        const dir = posix.dirname(page) === '.' ? '' : posix.dirname(page)
        const initial = new Set([page])
        const add = (ref: string | undefined) => {
          const file = ref === undefined ? undefined : toDistPath(ref, dir, files)
          if (file) initial.add(file)
        }
        for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) add(attribute(tag, 'src'))
        for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
          const rel = attribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? []
          if (rel.some((value) => ['stylesheet', 'modulepreload', 'preload'].includes(value)))
            add(attribute(tag, 'href'))
        }
        for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
          for (const ref of scanImports(body ?? '').static) add(ref)
        }
        entrypoints.push({ name: entryNameOf(page), initial: [...initial], lazy: [] })
      }
      return entrypoints
    },
  }
}

/** An entrypoint named in configuration by the dist files it loads first. */
export interface ExplicitEntry {
  name: string
  /** Globs relative to the dist directory, e.g. `assets/admin-*.js`. */
  globs: string[]
}

/** Entrypoints exactly as configured; imports of the matched files are followed afterwards. */
export function explicitResolver(entries: ExplicitEntry[]): EntrypointResolver {
  return {
    name: 'explicit',
    async resolve(distDir) {
      const files = (await listFiles(distDir)).filter((file) => !file.endsWith('.map'))
      return entries.map((entry) => {
        const globs = entry.globs.map((glob) => new Bun.Glob(glob))
        return {
          name: entry.name,
          initial: files.filter((file) => globs.some((glob) => glob.match(file))),
          lazy: [],
        }
      })
    },
  }
}

/**
 * Last resort: every JS file that no other JS file imports is an entrypoint. Works for any ES
 * module output without HTML or manifests.
 */
export function importGraphResolver(): EntrypointResolver {
  return {
    name: 'import-graph',
    async resolve(distDir) {
      const all = await listFiles(distDir)
      const files = new Set(all)
      const scripts = all.filter((file) => /\.[cm]?js$/.test(file))
      const imported = new Set<string>()
      for (const file of scripts) {
        const found = scanImports(await readFile(join(distDir, file), 'utf8'))
        for (const ref of [...found.static, ...found.dynamic]) {
          const target = toDistPath(ref, posix.dirname(file), files)
          if (target) imported.add(target)
        }
      }
      return scripts
        .filter((file) => !imported.has(file))
        .map((file) => ({ name: entryNameOf(normalizeAssetName(file)), initial: [file], lazy: [] }))
    },
  }
}
