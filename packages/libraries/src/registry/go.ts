import {
  compareGoVersions,
  escapeModulePath,
  isPseudoVersion,
  isStableGoVersion,
  modulePathOf,
} from '@holtkeeper/go-source'
import type { LibraryRepository } from '@holtkeeper/store'
import { unzipSync } from 'fflate'

import { isText } from '../archive.ts'
import { limitStream } from '../github/client.ts'
import type {
  ArchiveFiles,
  LibraryRef,
  LibraryRegistry,
  PublishedLibrary,
  PublishedVersion,
} from '../types.ts'

export interface GoRegistryOptions {
  fetch?: typeof fetch
  /** Default `https://proxy.golang.org`. */
  proxyUrl?: string
  /**
   * Module paths that must never reach the proxy or their `go-get` host (see `goPrivateMatcher`):
   * the registry answers `undefined` for them without a request.
   */
  isPrivate?: (path: string) => boolean
  /**
   * Largest module zip read, default 200 MB: a bigger one fails with `DownloadTooLargeError`
   * (up front from `Content-Length`, else once that many bytes arrived) before it is unzipped.
   */
  maxDownloadBytes?: number
}

/**
 * Whether a module path matches one of `GOPRIVATE`-style patterns: comma-separated globs (`*`, `?`,
 * `[...]` inside one path element) that each match a prefix of whole path elements, so
 * `gitlab.example/shapes` covers `gitlab.example/shapes/geom/v2` but not `gitlab.example/shapes2`.
 * Empty patterns match nothing.
 */
export function goPrivateMatcher(patterns: readonly string[]): (path: string) => boolean {
  const globs = patterns
    .flatMap((pattern) => pattern.split(','))
    .map((pattern) => pattern.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .map((pattern) => ({ elements: pattern.split('/').length, glob: new Bun.Glob(pattern) }))
  return (path) => {
    const elements = path.split('/')
    return globs.some(
      (item) =>
        elements.length >= item.elements &&
        item.glob.match(elements.slice(0, item.elements).join('/')),
    )
  }
}

const maxMajor = 100
const maxFileSize = 1_000_000
const maxSourceBytes = 100_000_000
const infoConcurrency = 8

const directRepositoryHosts = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])

const repositoryOf = (url: string, directory?: string): LibraryRepository | undefined => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const segments = parsed.pathname
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
  if (segments.length < 2) return undefined
  const path = `${segments[0]}/${segments[1]}`
  const dir = directory?.replace(/^\/+|\/+$/g, '')
  return {
    host: parsed.host,
    path,
    ...(dir ? { directory: dir } : {}),
    url: `https://${parsed.host}/${path}`,
  }
}

const metaContent = (html: string, name: string) => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const nameAttr = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (nameAttr !== name) continue
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (content) return content.trim().split(/\s+/)
  }
  return undefined
}

/** Keeps documentation and API sources of a module zip. */
export const keepModuleFile = (path: string) => {
  const segments = path.split('/')
  if (segments.some((segment) => segment === 'vendor' || segment === 'testdata')) return false
  const base = segments.at(-1) ?? ''
  if (base === 'go.mod') return true
  if (/\.(md|txt)$/i.test(base)) return true
  return base.endsWith('.go') && !base.endsWith('_test.go')
}

/** Text of a `// Deprecated:` comment of a `go.mod`, before or on its `module` line. */
export function moduleDeprecation(mod: string) {
  const lines = mod.split('\n')
  const index = lines.findIndex((line) => /^\s*module\s/.test(line))
  if (index < 0) return undefined
  const inline = /\/\/\s*Deprecated:\s*(.*)$/.exec(lines[index] ?? '')?.[1]
  if (inline !== undefined) return inline.trim()
  const comment: string[] = []
  for (let i = index - 1; i >= 0; i--) {
    const match = /^\s*\/\/ ?(.*)$/.exec(lines[i] ?? '')
    if (!match) break
    comment.unshift(match[1] ?? '')
  }
  const text = comment.join('\n')
  const deprecated = /(?:^|\n\s*\n)Deprecated:\s*([\s\S]*?)(?:\n\s*\n|$)/.exec(text)?.[1]
  return deprecated === undefined ? undefined : deprecated.replace(/\s+/g, ' ').trim()
}

/** Keeps the files of a module zip worth reading as source: everything outside `vendor/`. */
const keepSourceFile = (path: string) => !path.split('/').includes('vendor')

/**
 * `LibraryRegistry` over the Go module proxy. A library is a module path without `/vN`; its
 * versions are joined from every major path that exists (probed upward from `/v2` until the
 * proxy answers 404 or 410). Pseudo-versions are left out. Repository comes from the module
 * path for GitHub, GitLab and Bitbucket, else from the `go-source`/`go-import` meta tags of
 * `https://<path>?go-get=1`. Deprecation is the `// Deprecated:` comment in the `go.mod` of each
 * major's newest version and applies to every version of that major. `archive` keeps the docs and
 * non-test `.go` files of the module zip, `source` every text file outside `vendor/`. Paths
 * `isPrivate` matches are never requested.
 */
export function goRegistry(options: GoRegistryOptions = {}): LibraryRegistry {
  const get = options.fetch ?? globalThis.fetch
  const isPrivate = options.isPrivate ?? (() => false)
  const proxy = (options.proxyUrl ?? 'https://proxy.golang.org').replace(/\/$/, '')
  const moduleUrl = (path: string) => `${proxy}/${escapeModulePath(path)}`
  const headers = { 'user-agent': 'holtkeeper' }
  const maxDownloadBytes = options.maxDownloadBytes ?? 200_000_000

  const request = async (url: string) => {
    try {
      return await get(url, { headers })
    } catch {
      return undefined
    }
  }
  const text = async (url: string) => {
    const response = await request(url)
    return response?.ok ? response.text() : undefined
  }
  const field = async (url: string, key: string): Promise<unknown> => {
    const body = await text(url)
    if (body === undefined) return undefined
    try {
      const value: unknown = JSON.parse(body)
      return value && typeof value === 'object' ? Reflect.get(value, key) : undefined
    } catch {
      return undefined
    }
  }

  const listOf = async (path: string) => {
    const response = await request(`${moduleUrl(path)}/@v/list`)
    if (!response) return { exists: false, versions: [] }
    if (response.status === 404 || response.status === 410) return { exists: false, versions: [] }
    if (!response.ok) throw new Error(`Go proxy answered ${response.status} for ${path}`)
    const versions = (await response.text())
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !isPseudoVersion(line))
    return { exists: true, versions }
  }

  const latestOf = async (path: string) => {
    const version = await field(`${moduleUrl(path)}/@latest`, 'Version')
    return typeof version === 'string' ? version : undefined
  }

  const timeOf = async (path: string, version: string) => {
    const time = await field(`${moduleUrl(path)}/@v/${escapeModulePath(version)}.info`, 'Time')
    return typeof time === 'string' ? time : undefined
  }

  const repository = async (name: string): Promise<LibraryRepository | undefined> => {
    const [host, owner, repo, ...rest] = name.split('/')
    if (host && owner && repo && directRepositoryHosts.has(host))
      return repositoryOf(`https://${host}/${owner}/${repo}`, rest.join('/'))
    const html = await text(`https://${name}?go-get=1`)
    if (!html) return undefined
    const source = metaContent(html, 'go-source')
    const imported = metaContent(html, 'go-import')
    const prefix = source?.[0] ?? imported?.[0]
    const directory =
      prefix && name.startsWith(`${prefix}/`) ? name.slice(prefix.length + 1) : undefined
    const sourceHome = source?.[1]
    if (sourceHome && /^https?:\/\//.test(sourceHome)) {
      const found = repositoryOf(sourceHome, directory)
      if (found && directRepositoryHosts.has(found.host)) return found
    }
    const importUrl = imported?.[2]
    return importUrl ? repositoryOf(importUrl, directory) : undefined
  }

  const library = async (ref: LibraryRef): Promise<PublishedLibrary | undefined> => {
    const name = ref.name
    if (isPrivate(name)) return undefined
    const majors: { path: string; versions: string[] }[] = []
    const base = await listOf(name)
    if (base.exists) majors.push({ path: name, versions: base.versions })
    if (!name.startsWith('gopkg.in/')) {
      for (let major = 2; major <= maxMajor; major++) {
        const path = `${name}/v${major}`
        const found = await listOf(path)
        if (!found.exists) break
        majors.push({ path, versions: found.versions })
      }
    }
    if (majors.length === 0) return undefined

    const versions: PublishedVersion[] = []
    let latest: string | undefined
    for (const major of majors) {
      const reported = await latestOf(major.path)
      const known = new Set(major.versions)
      if (reported && !isPseudoVersion(reported) && !known.has(reported)) {
        major.versions.push(reported)
        known.add(reported)
      }
      const sorted = [...known].toSorted(compareGoVersions)
      const newest = sorted.findLast(isStableGoVersion) ?? sorted.at(-1)
      const mod = newest
        ? await text(`${moduleUrl(major.path)}/@v/${escapeModulePath(newest)}.mod`)
        : undefined
      const deprecated = mod ? moduleDeprecation(mod) : undefined
      for (let i = 0; i < sorted.length; i += infoConcurrency) {
        const batch = sorted.slice(i, i + infoConcurrency)
        const times = await Promise.all(batch.map((version) => timeOf(major.path, version)))
        batch.forEach((version, index) => {
          const publishedAt = times[index]
          versions.push({
            version,
            ...(publishedAt ? { publishedAt } : {}),
            ...(deprecated !== undefined ? { deprecated } : {}),
          })
        })
      }
      const stable = sorted.filter(isStableGoVersion).at(-1)
      if (stable && (!latest || compareGoVersions(stable, latest) > 0)) latest = stable
    }
    const repo = await repository(name)
    const newest = latest ?? versions.at(-1)?.version
    return {
      ecosystem: 'Go',
      name,
      homepage: `https://pkg.go.dev/${name}`,
      ...(repo ? { repository: repo } : {}),
      ...(newest ? { latest: newest } : {}),
      versions: versions.toSorted((a, b) => compareGoVersions(a.version, b.version)),
    }
  }

  const moduleZip = async (
    ref: LibraryRef,
    version: string,
    keep: (path: string, size: number) => boolean,
  ): Promise<ArchiveFiles | undefined> => {
    const path = modulePathOf(ref.name, version)
    if (isPrivate(path)) return undefined
    const response = await request(`${moduleUrl(path)}/@v/${escapeModulePath(version)}.zip`)
    if (!response || response.status === 404 || response.status === 410) return undefined
    if (!response.ok) throw new Error(`Go proxy answered ${response.status} for ${path}@${version}`)
    const prefix = `${path}@${version}/`
    const strip = (name: string) =>
      name.startsWith(prefix) ? name.slice(prefix.length) : name.slice(name.indexOf('/') + 1)
    const body = limitStream(response, maxDownloadBytes, `module zip of ${path}@${version}`)
    const entries = unzipSync(new Uint8Array(await new Response(body).arrayBuffer()), {
      filter: (file) =>
        !file.name.endsWith('/') &&
        file.originalSize <= maxFileSize &&
        keep(strip(file.name), file.originalSize),
    })
    const files: ArchiveFiles = new Map()
    for (const [name, bytes] of Object.entries(entries)) files.set(strip(name), bytes)
    return files
  }

  const archive = (ref: LibraryRef, version: string) =>
    moduleZip(ref, version, (path) => keepModuleFile(path))

  const source = async (ref: LibraryRef, version: string) => {
    let budget = maxSourceBytes
    const files = await moduleZip(ref, version, (path, size) => {
      if (!keepSourceFile(path) || size > budget) return false
      budget -= size
      return true
    })
    if (!files) return undefined
    for (const [path, bytes] of files) if (!isText(bytes)) files.delete(path)
    return files
  }

  return { library, archive, source }
}
