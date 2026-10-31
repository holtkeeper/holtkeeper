import { safeArchivePath } from '@holtkeeper/artifacts'

import type { ArchiveFiles } from './types.ts'

/** Options of `readTarball`. */
export interface TarballOptions {
  /** Drop the first path segment (`package/` of npm tarballs, `owner-repo-sha/` of GitHub ones). */
  stripTop?: boolean
  /** Keep only paths (after stripping) this accepts. */
  keep?: (path: string) => boolean
  /** Files larger than this are skipped. Default 2 MB. */
  maxFileBytes?: number
  /** Files are read until their sizes add up to this; the rest are skipped. Default 64 MB. */
  maxTotalBytes?: number
  /** Skip files that look binary (a NUL byte in the first 8 KB). Default `true`. */
  textOnly?: boolean
}

/** Whether `data` looks like text: no NUL byte in its first 8 KB. */
export function isText(data: Uint8Array): boolean {
  const end = Math.min(data.length, 8192)
  for (let i = 0; i < end; i++) if (data[i] === 0) return false
  return true
}

const BLOCK = 512

const gzipMagic = (chunk: Uint8Array | undefined) => chunk?.[0] === 0x1f && chunk[1] === 0x8b

/** Exact-length reads over a byte stream; `undefined` once it ends early. */
function blockReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  let buffered: Uint8Array[] = []
  let length = 0
  let done = false
  const fill = async (n: number) => {
    while (length < n && !done) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read chunk after chunk
      const next = await reader.read()
      if (next.done) done = true
      else {
        buffered.push(next.value)
        length += next.value.length
      }
    }
    return length >= n
  }
  const take = (n: number) => {
    const out = new Uint8Array(n)
    let offset = 0
    while (offset < n) {
      const head = buffered[0]!
      const part = Math.min(head.length, n - offset)
      out.set(head.subarray(0, part), offset)
      offset += part
      if (part === head.length) buffered.shift()
      else buffered[0] = head.subarray(part)
    }
    length -= n
    return out
  }
  return {
    async read(n: number): Promise<Uint8Array | undefined> {
      return (await fill(n)) ? take(n) : undefined
    },
    async skip(n: number): Promise<boolean> {
      let left = n
      while (left > 0) {
        // oxlint-disable-next-line no-await-in-loop -- see above
        if (!(await fill(Math.min(left, 1 << 20)))) return false
        const part = Math.min(left, length)
        take(part)
        left -= part
      }
      return true
    },
    cancel() {
      buffered = []
      void reader.cancel().catch(() => {})
    },
  }
}

const ownBuffer = (chunk: Uint8Array): Uint8Array<ArrayBuffer> =>
  chunk.buffer instanceof ArrayBuffer
    ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    : new Uint8Array(chunk)

/** The stream, gunzipped when it starts with the gzip magic bytes. */
async function plainTar(stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader()
  const first = await reader.read()
  if (gzipMagic(first.done ? undefined : first.value)) {
    const gunzip = new DecompressionStream('gzip')
    const writer = gunzip.writable.getWriter()
    void (async () => {
      try {
        if (!first.done) await writer.write(ownBuffer(first.value))
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- a stream is read chunk after chunk
          const next = await reader.read()
          if (next.done) break
          // oxlint-disable-next-line no-await-in-loop -- see above
          await writer.write(ownBuffer(next.value))
        }
        await writer.close()
      } catch (error) {
        await writer.abort(error).catch(() => {})
        await reader.cancel(error).catch(() => {})
      }
    })()
    return gunzip.readable
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!first.done) controller.enqueue(first.value)
    },
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

const decoder = new TextDecoder()

const field = (header: Uint8Array, offset: number, size: number) => {
  const bytes = header.subarray(offset, offset + size)
  const end = bytes.indexOf(0)
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end))
}

const sizeOf = (header: Uint8Array) => {
  if (header[124]! & 0x80) {
    let size = 0
    for (let i = 125; i < 136; i++) size = size * 256 + header[i]!
    return size
  }
  const text = field(header, 124, 12).trim()
  return text ? Number.parseInt(text, 8) : 0
}

const paxRecords = (data: Uint8Array) => {
  const records = new Map<string, string>()
  for (const line of decoder.decode(data).split('\n')) {
    const match = /^\d+ ([^=]+)=(.*)$/s.exec(line)
    if (match) records.set(match[1]!, match[2]!)
  }
  return records
}

const checksumMatches = (header: Uint8Array) => {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
  return Number.parseInt(field(header, 148, 8).trim(), 8) === sum
}

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK

/**
 * The regular files of a tar or gzipped tar archive by relative path, with `/` separators. The
 * archive is read as a stream: only kept files are held in memory, so a large archive costs
 * the files it yields, not its size. Unsafe paths (absolute, `..`) are skipped, never resolved.
 * Throws when the bytes are not an archive, and with the stream's error when it fails (e.g.
 * `DownloadTooLargeError`).
 */
export async function readTarball(
  input: Uint8Array | ReadableStream<Uint8Array>,
  options: TarballOptions = {},
): Promise<ArchiveFiles> {
  const maxFile = options.maxFileBytes ?? 2_000_000
  let budget = options.maxTotalBytes ?? 64_000_000
  const textOnly = options.textOnly ?? true
  const source = input instanceof Uint8Array ? new Blob([input]).stream() : input
  const reader = blockReader(await plainTar(source))
  const files: ArchiveFiles = new Map()
  let longName: string | undefined
  let pax = new Map<string, string>()
  let sawHeader = false
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- entries follow each other in the stream
      const header = await reader.read(BLOCK)
      if (!header || header.every((byte) => byte === 0)) break
      if (!checksumMatches(header)) {
        if (!sawHeader) throw new Error('not a tar archive')
        break
      }
      sawHeader = true
      const magic = field(header, 257, 6)
      const type = String.fromCharCode(header[156] || 48)
      const size = pax.has('size') ? Number(pax.get('size')) : sizeOf(header)
      if (type === 'x' || type === 'g' || type === 'L') {
        // oxlint-disable-next-line no-await-in-loop -- see above
        const data = await reader.read(padded(size))
        if (!data) break
        if (type === 'x') pax = paxRecords(data.subarray(0, size))
        if (type === 'L') longName = field(data, 0, size)
        continue
      }
      const prefix = magic.startsWith('ustar') ? field(header, 345, 155) : ''
      const name =
        pax.get('path') ??
        longName ??
        (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
      pax = new Map()
      longName = undefined
      const wanted = type === '0' || type === '7' ? keepPath(name, options) : undefined
      if (wanted === undefined || size > maxFile || size > budget) {
        // oxlint-disable-next-line no-await-in-loop -- see above
        if (!(await reader.skip(padded(size)))) break
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      const block = await reader.read(padded(size))
      if (!block) break
      const data = block.slice(0, size)
      if (textOnly && !isText(data)) continue
      budget -= data.length
      files.set(wanted, data)
    }
  } finally {
    reader.cancel()
  }
  return files
}

/** The path `name` is kept under, or `undefined` when it is unsafe, a folder or not wanted. */
function keepPath(name: string, options: TarballOptions): string | undefined {
  let path: string
  try {
    path = safeArchivePath(name)
  } catch {
    return undefined
  }
  if (options.stripTop) {
    const slash = path.indexOf('/')
    if (slash < 0) return undefined
    path = path.slice(slash + 1)
  }
  if (!path || path.endsWith('/')) return undefined
  if (options.keep && !options.keep(path)) return undefined
  return path
}

/** UTF-8 text of an archive file; `undefined` when absent. */
export const fileText = (files: ArchiveFiles, path: string) => {
  const data = files.get(path)
  return data ? new TextDecoder().decode(data) : undefined
}
