import { describe, expect, test } from 'bun:test'

import { tarball } from '../test/fixtures.ts'
import { fileText, readTarball } from './archive.ts'
import { DownloadTooLargeError, limitStream } from './github/client.ts'

const encoder = new TextEncoder()

function header(name: string, size: number, type: string) {
  const block = new Uint8Array(512)
  const put = (text: string, offset: number) => block.set(encoder.encode(text), offset)
  put(name, 0)
  put('0000644\0', 100)
  put(`${size.toString(8).padStart(11, '0')}\0`, 124)
  put('        ', 148)
  put(type, 156)
  put('ustar\0', 257)
  put('00', 263)
  let sum = 0
  for (const byte of block) sum += byte
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}

function entry(name: string, data: Uint8Array | string, type = '0') {
  const body = typeof data === 'string' ? encoder.encode(data) : data
  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512)
  padded.set(body)
  return [header(name, body.length, type), padded]
}

const pax = (records: Record<string, string>) =>
  Object.entries(records)
    .map(([key, value]) => {
      const line = ` ${key}=${value}\n`
      let length = line.length + 1
      while (`${length}${line}`.length !== length) length = `${length}${line}`.length
      return `${length}${line}`
    })
    .join('')

const tar = (...parts: Uint8Array[][]) => {
  const blocks = [...parts.flat(), new Uint8Array(1024)]
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0))
  let offset = 0
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.length
  }
  return out
}

const streamOf = (bytes: Uint8Array, chunk = 100) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk))
      controller.close()
    },
  })

describe('readTarball', () => {
  test('reads a gzipped tarball, from bytes and from a chunked stream', async () => {
    const bytes = await tarball('package', { 'README.md': '# Hi', 'docs/a.md': 'A' })
    for (const input of [bytes, streamOf(bytes, 7)]) {
      // oxlint-disable-next-line no-await-in-loop -- two inputs, one after the other
      const files = await readTarball(input, { stripTop: true })
      expect([...files.keys()].toSorted()).toEqual(['README.md', 'docs/a.md'])
      expect(fileText(files, 'README.md')).toBe('# Hi')
    }
  })

  test('takes names from pax records and GNU long names, skips global headers', async () => {
    const long = `top/${'d/'.repeat(80)}file.md`
    const gnu = `top/${'e/'.repeat(80)}gnu.md`
    const files = await readTarball(
      tar(
        entry('pax_global_header', pax({ comment: 'abc123' }), 'g'),
        entry('PaxHeader', pax({ path: long }), 'x'),
        entry('short-name', 'from pax'),
        entry('././@LongLink', `${gnu}\0`, 'L'),
        entry('truncated', 'from gnu'),
        entry('top/plain.md', 'plain'),
      ),
      { stripTop: true },
    )
    expect(fileText(files, long.slice(4))).toBe('from pax')
    expect(fileText(files, gnu.slice(4))).toBe('from gnu')
    expect(fileText(files, 'plain.md')).toBe('plain')
    expect(files.size).toBe(3)
  })

  test('skips unwanted, oversized, binary and unsafe entries without stopping', async () => {
    const binary = new Uint8Array([1, 0, 2])
    const files = await readTarball(
      tar(
        entry('top/dir/', '', '5'),
        entry('top/skip.js', 'x'.repeat(2000)),
        entry('top/big.md', 'y'.repeat(3000)),
        entry('top/bin.md', binary),
        entry('top/../escape.md', 'no'),
        entry('top/keep.md', 'kept'),
        entry('top/link.md', '', '2'),
      ),
      { stripTop: true, keep: (path) => path.endsWith('.md'), maxFileBytes: 2500 },
    )
    expect([...files.keys()]).toEqual(['keep.md'])
  })

  test('stops adding files once the total budget is spent', async () => {
    const files = await readTarball(
      tar(entry('a.md', 'a'.repeat(600)), entry('b.md', 'b'.repeat(600)), entry('c.md', 'c')),
      { maxTotalBytes: 700 },
    )
    expect([...files.keys()]).toEqual(['a.md', 'c.md'])
  })

  test('rejects bytes that are not a tar archive', async () => {
    expect(readTarball(encoder.encode('not an archive at all'.repeat(40)))).rejects.toThrow(
      'not a tar archive',
    )
  })

  test('fails with the stream error when a download grows past its limit', async () => {
    const bytes = await tarball('top', { 'a.md': 'a'.repeat(50_000), 'b.md': 'b'.repeat(50_000) })
    const response = new Response(streamOf(bytes, 64))
    const stream = limitStream(response, Math.floor(bytes.length / 2), 'tarball')
    expect(readTarball(stream, { stripTop: true })).rejects.toBeInstanceOf(DownloadTooLargeError)
  })
})

describe('limitStream', () => {
  test('refuses a body whose Content-Length is over the limit before reading it', () => {
    const response = new Response('x'.repeat(10), { headers: { 'content-length': '10' } })
    expect(() => limitStream(response, 5, 'file')).toThrow(DownloadTooLargeError)
  })

  test('passes a body within the limit through', async () => {
    const stream = limitStream(new Response('hello'), 5, 'file')
    expect(await new Response(stream).text()).toBe('hello')
  })
})
