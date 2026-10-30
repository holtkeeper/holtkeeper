import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { Asset } from './data.ts'
import { codeExtensions, describe, extensionOf, formats, isText, referenceText } from './formats.ts'

/** Folders that usually hold shipped assets, relative to the repository root. */
export const defaultRoots = ['public/**', 'assets/**', 'static/**', 'src/**/assets/**', 'res/**']

/** Never scanned. */
export const defaultIgnore = ['**/node_modules/**', '**/.git/**', '**/.*/**']

/** Files of unknown formats are inventoried from this size on. */
export const OTHER_MIN_BYTES = 256 * 1024

export interface InventoryOptions {
  dir: string
  roots: string[]
  /** Globs whose files are marked `origin: 'build'`, e.g. `dist/**`. */
  buildRoots?: string[]
  ignore?: string[]
}

/** One inventoried file with the text it contains, for reference search. */
export interface ScannedAsset {
  asset: Asset
  text?: string
}

const sha256 = (bytes: Uint8Array) =>
  new Bun.CryptoHasher('sha256').update(bytes).digest('hex').slice(0, 16)

/** Repository-relative files matching any of `patterns`, excluding `ignore`, sorted. */
export async function scanFiles(
  dir: string,
  patterns: readonly string[],
  ignore: readonly string[] = [],
): Promise<string[]> {
  const ignored = ignore.map((pattern) => new Bun.Glob(pattern))
  const found = new Set<string>()
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: dir, onlyFiles: true, dot: true })) {
      const normalized = path.replaceAll('\\', '/')
      if (!ignored.some((glob) => glob.match(normalized))) found.add(normalized)
    }
  }
  return [...found].toSorted()
}

/**
 * Every asset under the roots: known formats of any size and unknown binaries from
 * `OTHER_MIN_BYTES` on; code, styles and documents are skipped. Each file gets its size, content
 * hash, gzip size (text formats) and header metadata.
 */
export async function inventory(options: InventoryOptions): Promise<ScannedAsset[]> {
  const ignore = [...defaultIgnore, ...(options.ignore ?? [])]
  const buildGlobs = (options.buildRoots ?? []).map((pattern) => new Bun.Glob(pattern))
  const paths = await scanFiles(
    options.dir,
    [...options.roots, ...(options.buildRoots ?? [])],
    ignore,
  )
  const scanned: ScannedAsset[] = []
  for (const path of paths) {
    const extension = extensionOf(path)
    if (codeExtensions.has(extension)) continue
    const absolute = join(options.dir, path)
    if (!formats[extension] && (await stat(absolute)).size < OTHER_MIN_BYTES) continue
    const bytes = new Uint8Array(await readFile(absolute))
    const { kind, meta } = describe(path, bytes)
    const text = referenceText(path, bytes)
    scanned.push({
      asset: {
        path,
        kind,
        format: extension,
        bytes: bytes.byteLength,
        ...(isText(path) ? { gzip: Bun.gzipSync(bytes, { level: 9 }).byteLength } : {}),
        hash: sha256(bytes),
        origin: buildGlobs.some((glob) => glob.match(path)) ? 'build' : 'source',
        ...meta,
      },
      ...(text === undefined ? {} : { text }),
    })
  }
  return scanned
}
