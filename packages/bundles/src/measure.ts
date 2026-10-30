import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'

import type { Sizes } from './data.ts'
import type { RawSourceMap } from './sourcemap.ts'

/** Raw, gzip (level 9) and brotli (quality 11) sizes of one file's content. */
export function measure(content: Uint8Array<ArrayBuffer>): Sizes {
  return {
    raw: content.byteLength,
    gzip: Bun.gzipSync(content, { level: 9 }).byteLength,
    brotli: brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
      .byteLength,
  }
}

function asSourceMap(value: unknown): RawSourceMap | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const sources = 'sources' in value ? value.sources : undefined
  const mappings = 'mappings' in value ? value.mappings : undefined
  const sourceRoot = 'sourceRoot' in value ? value.sourceRoot : undefined
  if (!Array.isArray(sources) || typeof mappings !== 'string') return undefined
  return {
    sources: sources.map((source) => (typeof source === 'string' ? source : null)),
    mappings,
    ...(typeof sourceRoot === 'string' ? { sourceRoot } : {}),
  }
}

/** A source map found for a generated file, with the directory its relative sources resolve from. */
export interface FoundSourceMap {
  map: RawSourceMap
  dir: string
}

/**
 * Loads the source map of a JS or CSS file from its `sourceMappingURL` comment (a file or an
 * inline `data:` URL), falling back to `<file>.map`. Returns `undefined` when there is none or it
 * cannot be parsed.
 */
export async function findSourceMap(
  path: string,
  code: string,
): Promise<FoundSourceMap | undefined> {
  const at = code.lastIndexOf('sourceMappingURL=')
  const url =
    at === -1 ? undefined : /^[^\s*'"]+/.exec(code.slice(at + 'sourceMappingURL='.length))?.[0]
  const candidates: string[] = []
  if (url?.startsWith('data:')) {
    const comma = url.indexOf(',')
    const body = url.slice(comma + 1)
    try {
      const text = url.slice(0, comma).endsWith(';base64')
        ? Buffer.from(body, 'base64').toString('utf8')
        : decodeURIComponent(body)
      const map = asSourceMap(JSON.parse(text))
      return map && { map, dir: dirname(path) }
    } catch {
      return undefined
    }
  }
  if (url && !/^[a-z][\w+.-]*:/i.test(url)) {
    try {
      candidates.push(join(dirname(path), decodeURIComponent(url)))
    } catch {}
  }
  candidates.push(`${path}.map`)
  for (const candidate of candidates) {
    try {
      const map = asSourceMap(JSON.parse(await readFile(candidate, 'utf8')))
      if (!map) continue
      return { map, dir: dirname(candidate) }
    } catch {}
  }
  return undefined
}
