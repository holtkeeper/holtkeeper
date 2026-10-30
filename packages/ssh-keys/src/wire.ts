/** Builds SSH wire-format data (RFC 4251): big-endian uint32s and length-prefixed strings. */
export class WireWriter {
  private parts: Uint8Array[] = []

  uint32(value: number): this {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value >>> 0)
    this.parts.push(bytes)
    return this
  }

  string(value: string | Uint8Array): this {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    this.uint32(bytes.length)
    this.parts.push(bytes)
    return this
  }

  raw(bytes: Uint8Array): this {
    this.parts.push(bytes)
    return this
  }

  get length(): number {
    return this.parts.reduce((sum, part) => sum + part.length, 0)
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const part of this.parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }
}

/** Reads SSH wire-format data; every read throws on truncated input. */
export class WireReader {
  private offset = 0
  private readonly view: DataView
  private readonly data: Uint8Array

  constructor(data: Uint8Array) {
    this.data = data
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  get remaining(): number {
    return this.data.length - this.offset
  }

  uint32(): number {
    if (this.remaining < 4) throw new Error('truncated SSH data')
    const value = this.view.getUint32(this.offset)
    this.offset += 4
    return value
  }

  bytes(length: number): Uint8Array {
    if (this.remaining < length) throw new Error('truncated SSH data')
    const value = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  string(): Uint8Array {
    return this.bytes(this.uint32())
  }

  text(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.string())
  }

  rest(): Uint8Array {
    return this.bytes(this.remaining)
  }
}

export const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
