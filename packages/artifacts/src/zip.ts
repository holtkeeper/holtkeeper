import { type Zippable, unzipSync, zipSync } from 'fflate'

/** One file of an archive; `path` is relative, with `/` separators. */
export interface ZipEntry {
  path: string
  data: Uint8Array | string
}

const compressed = /\.(png|jpe?g|webp|avif|gif|woff2?|zip|gz|br|zst|mp4|webm)$/i

/** Throws for absolute paths, `..` segments and empty names, which would unpack outside the target. */
export function safeArchivePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  const segments = normalized.split('/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized) ||
    segments.some((segment) => segment === '..' || segment === '')
  )
    throw new Error(`unsafe archive path: ${path}`)
  return normalized
}

/**
 * A ZIP archive of `entries`. Already-compressed formats (images, fonts, archives) are stored as
 * is, the rest deflated. Throws on unsafe or duplicate paths.
 */
export function zipArtifacts(entries: readonly ZipEntry[]): Uint8Array {
  const files: Zippable = {}
  for (const { path, data } of entries) {
    const name = safeArchivePath(path)
    if (name in files) throw new Error(`duplicate archive path: ${path}`)
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    files[name] = [bytes, { level: compressed.test(name) ? 0 : 6 }]
  }
  return zipSync(files)
}

/** The files of a ZIP archive by path; throws on malformed archives or unsafe paths. */
export function unzipArtifacts(zip: Uint8Array): Record<string, Uint8Array> {
  const files = unzipSync(zip)
  for (const path of Object.keys(files)) if (!path.endsWith('/')) safeArchivePath(path)
  return Object.fromEntries(Object.entries(files).filter(([path]) => !path.endsWith('/')))
}
