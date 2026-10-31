import type { LibraryRepository } from '@holtkeeper/store'

import { type TarballOptions, readTarball } from '../archive.ts'
import { limitStream } from '../github/client.ts'
import type {
  ArchiveFiles,
  LibraryRef,
  LibraryRegistry,
  PublishedLibrary,
  PublishedVersion,
} from '../types.ts'

export interface NpmRegistryOptions {
  fetch?: typeof fetch
  /** Default `https://registry.npmjs.org`. */
  url?: string
  /** Largest tarball downloaded. Default 50 MB. */
  maxTarballBytes?: number
  /** Extra request headers per URL, e.g. a token for a private registry's host. */
  headers?: (url: string) => Record<string, string> | undefined
  /**
   * What `archive` keeps. Default: Markdown, text, `package.json` and declaration files up to
   * 2 MB each (`keepNpmFile`, text only).
   */
  archive?: Pick<TarballOptions, 'keep' | 'textOnly' | 'maxFileBytes' | 'maxTotalBytes'>
}

const docFile = /\.(md|mdx|markdown|txt)$/i
const declarationFile = /\.d\.[cm]?ts$/i

/** Whether an npm archive path is kept: documentation, `package.json` files and declarations. */
export const keepNpmFile = (path: string) =>
  !path.split('/').includes('node_modules') &&
  (docFile.test(path) || declarationFile.test(path) || /(^|\/)package\.json$/.test(path))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const shorthandHosts: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
}

/**
 * The repository an npm `repository` field names: URLs (`git+https://`, `git://`, `ssh://git@`,
 * `git@host:owner/repo`), `github:owner/repo`-style shorthands and bare `owner/repo` (GitHub).
 * `directory` and `/tree/<branch>/<dir>` URLs set `directory`. `undefined` when nothing parses.
 */
export function normalizeRepository(value: unknown): LibraryRepository | undefined {
  const raw = isRecord(value) ? text(value['url']) : text(value)
  if (!raw) return undefined
  let directory = isRecord(value) ? text(value['directory']) : undefined
  let host: string | undefined
  let segments: string[] = []
  const shorthand = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(raw)
  if (shorthand?.[2]) {
    host = shorthandHosts[shorthand[1] ?? 'github']
    segments = shorthand[2].split('/')
  } else {
    const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(raw)
    if (scp?.[1] && scp[2] && !/^\d+$/.test(scp[2].split('/')[0] ?? '')) {
      host = scp[1]
      segments = scp[2].split('/')
    } else {
      try {
        const url = new URL(raw.replace(/^git\+/, ''))
        host = url.hostname
        segments = url.pathname.split('/')
      } catch {
        return undefined
      }
    }
  }
  segments = segments.filter(Boolean)
  const owner = segments[0]
  const name = segments[1]?.replace(/\.git$/, '')
  if (!host || !owner || !name) return undefined
  if (!directory && segments[2] === 'tree' && segments.length > 4)
    directory = segments.slice(4).join('/')
  directory = directory?.replace(/^\.?\/+|\/+$/g, '')
  const path = `${owner}/${name}`
  return {
    host: host.toLowerCase(),
    path,
    ...(directory ? { directory } : {}),
    url: `https://${host.toLowerCase()}/${path}`,
  }
}

const packumentPath = (name: string) =>
  name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)

/**
 * `LibraryRegistry` for npm or any registry speaking its protocol (GitLab, GitHub Packages,
 * Verdaccio, Nexus) at `url`. `library` reads the full packument (the abbreviated one lacks `time`,
 * `repository` and `gitHead`); `archive` downloads the version's tarball and keeps Markdown, text,
 * `package.json` and declaration files up to 2 MB each (see `archive`), without the `package/`
 * folder. Packuments are cached for the lifetime of the instance, so create one per run.
 */
export function npmRegistry(options: NpmRegistryOptions = {}): LibraryRegistry {
  const doFetch = options.fetch ?? fetch
  const base = (options.url ?? 'https://registry.npmjs.org').replace(/\/$/, '')
  const maxTarball = options.maxTarballBytes ?? 50_000_000
  const packuments = new Map<string, Promise<Record<string, unknown> | undefined>>()

  const packument = (name: string) => {
    let pending = packuments.get(name)
    if (!pending) {
      pending = (async () => {
        const url = `${base}/${packumentPath(name)}`
        const response = await doFetch(url, {
          headers: { accept: 'application/json', ...options.headers?.(url) },
        })
        if (response.status === 404) return undefined
        if (!response.ok) throw new Error(`npm registry ${response.status} for ${name}`)
        const body: unknown = await response.json()
        return isRecord(body) ? body : undefined
      })()
      packuments.set(name, pending)
      pending.catch(() => packuments.delete(name))
    }
    return pending
  }

  return {
    async library(ref: LibraryRef): Promise<PublishedLibrary | undefined> {
      if (ref.ecosystem !== 'npm') return undefined
      const body = await packument(ref.name)
      if (!body) return undefined
      const versions = isRecord(body['versions']) ? body['versions'] : {}
      const times = isRecord(body['time']) ? body['time'] : {}
      const list: PublishedVersion[] = Object.entries(versions).map(([version, manifest]) => {
        const meta = isRecord(manifest) ? manifest : {}
        const deprecated = meta['deprecated']
        const publishedAt = text(times[version])
        const commit = text(meta['gitHead'])
        return {
          version,
          ...(publishedAt ? { publishedAt } : {}),
          ...(typeof deprecated === 'string' && deprecated
            ? { deprecated }
            : deprecated === true
              ? { deprecated: 'deprecated' }
              : {}),
          ...(commit ? { commit } : {}),
        }
      })
      const tags = isRecord(body['dist-tags']) ? body['dist-tags'] : {}
      const latest = text(tags['latest'])
      const latestManifest = latest && isRecord(versions[latest]) ? versions[latest] : {}
      const repository = normalizeRepository(body['repository'] ?? latestManifest['repository'])
      const homepage = text(body['homepage'] ?? latestManifest['homepage'])
      const description = text(body['description'] ?? latestManifest['description'])
      return {
        ecosystem: 'npm',
        name: ref.name,
        versions: list,
        ...(latest ? { latest } : {}),
        ...(repository ? { repository } : {}),
        ...(homepage ? { homepage } : {}),
        ...(description ? { description } : {}),
      }
    },

    async archive(ref: LibraryRef, version: string): Promise<ArchiveFiles | undefined> {
      if (ref.ecosystem !== 'npm') return undefined
      const body = await packument(ref.name)
      const versions = isRecord(body?.['versions']) ? body['versions'] : {}
      const manifest = versions[version]
      if (!isRecord(manifest)) return undefined
      const dist = isRecord(manifest['dist']) ? manifest['dist'] : {}
      const basename = ref.name.split('/').at(-1) ?? ref.name
      const tarball = text(dist['tarball']) ?? `${base}/${ref.name}/-/${basename}-${version}.tgz`
      const headers = options.headers?.(tarball)
      const response = await doFetch(tarball, headers ? { headers } : undefined)
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`npm tarball ${response.status} for ${ref.name}@${version}`)
      return readTarball(
        limitStream(response, maxTarball, `npm tarball of ${ref.name}@${version}`),
        { keep: keepNpmFile, ...options.archive, stripTop: true },
      )
    },
  }
}
