import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto'

import { toBase64, WireReader, WireWriter } from './wire.ts'

/** Key algorithms `generateKeyPair` can create. */
export type SshKeyType = 'ed25519'

/** A freshly generated key pair in OpenSSH formats. */
export interface SshKeyPair {
  type: SshKeyType
  /** One `authorized_keys` line: `ssh-ed25519 AAAA… comment`, without a trailing newline. */
  publicKey: string
  /** Unencrypted `-----BEGIN OPENSSH PRIVATE KEY-----` file contents, ending with a newline. */
  privateKey: string
  /** `SHA256:…` as `ssh-keygen -lf` prints it. */
  fingerprint: string
  comment: string
}

/** An OpenSSH public key split into its parts. */
export interface SshPublicKey {
  /** Algorithm name, e.g. `ssh-ed25519` or `ecdsa-sha2-nistp256`. */
  type: string
  /** The wire-format key blob. */
  blob: Uint8Array
  comment: string
  fingerprint: string
}

/** The public half and comment read from an OpenSSH private key file. */
export interface SshPrivateKeyInfo {
  type: string
  /** One `authorized_keys` line with the key's comment. */
  publicKey: string
  comment: string
  fingerprint: string
}

const ED25519 = 'ssh-ed25519'
const MAGIC = 'openssh-key-v1\0'
const BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----'
const END = '-----END OPENSSH PRIVATE KEY-----'
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

const assertComment = (comment: string) => {
  if (/[\r\n]/.test(comment)) throw new Error('an SSH key comment cannot contain line breaks')
}

const ed25519Blob = (publicKey: Uint8Array) =>
  new WireWriter().string(ED25519).string(publicKey).bytes()

const fingerprintOfBlob = (blob: Uint8Array) =>
  `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`

const publicLine = (type: string, blob: Uint8Array, comment: string) =>
  comment ? `${type} ${toBase64(blob)} ${comment}` : `${type} ${toBase64(blob)}`

/** Encodes an Ed25519 key as an unencrypted `openssh-key-v1` file. */
function encodeEd25519PrivateKey(
  seed: Uint8Array,
  publicKey: Uint8Array,
  comment: string,
  checkInt: number,
): string {
  const secret = new Uint8Array(64)
  secret.set(seed, 0)
  secret.set(publicKey, 32)
  const section = new WireWriter()
    .uint32(checkInt)
    .uint32(checkInt)
    .string(ED25519)
    .string(publicKey)
    .string(secret)
    .string(comment)
  // Cipher "none" has a block size of 8; padding bytes are 1, 2, 3, … as OpenSSH writes them.
  const padding: number[] = []
  for (let i = 1; (section.length + padding.length) % 8 !== 0; i++) padding.push(i)
  section.raw(Uint8Array.from(padding))

  const file = new WireWriter()
    .raw(new TextEncoder().encode(MAGIC))
    .string('none')
    .string('none')
    .string('')
    .uint32(1)
    .string(ed25519Blob(publicKey))
    .string(section.bytes())
    .bytes()
  const body = toBase64(file).match(/.{1,70}/g) ?? []
  return `${BEGIN}\n${body.join('\n')}\n${END}\n`
}

/**
 * Generates a key pair with `node:crypto` and encodes it the way `ssh-keygen` does, so OpenSSH,
 * git and forges accept both halves as they are. The private key is not encrypted; keep it sealed.
 */
export function generateKeyPair(options: { type: SshKeyType; comment?: string }): SshKeyPair {
  if (options.type !== 'ed25519')
    throw new Error(`unsupported SSH key type: ${String(options.type)}`)
  const comment = options.comment ?? ''
  assertComment(comment)
  const pair = generateKeyPairSync('ed25519')
  const { x } = pair.publicKey.export({ format: 'jwk' })
  const { d } = pair.privateKey.export({ format: 'jwk' })
  if (!x || !d) throw new Error('node:crypto returned an incomplete Ed25519 key')
  const publicKey = new Uint8Array(Buffer.from(x, 'base64url'))
  const seed = new Uint8Array(Buffer.from(d, 'base64url'))
  const blob = ed25519Blob(publicKey)
  return {
    type: 'ed25519',
    publicKey: publicLine(ED25519, blob, comment),
    privateKey: encodeEd25519PrivateKey(seed, publicKey, comment, randomBytes(4).readUInt32BE()),
    fingerprint: fingerprintOfBlob(blob),
    comment,
  }
}

/**
 * Parses one OpenSSH public key line (`type base64 [comment]`). Throws when the line is malformed
 * or the algorithm named in the line differs from the one inside the blob.
 */
export function parsePublicKey(line: string): SshPublicKey {
  const match = /^\s*(\S+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*?))?\s*$/.exec(line)
  if (!match) throw new Error('not an OpenSSH public key line')
  const [, type = '', base64 = '', comment = ''] = match
  const blob = new Uint8Array(Buffer.from(base64, 'base64'))
  let inner: string
  try {
    inner = new WireReader(blob).text()
  } catch {
    throw new Error('not an OpenSSH public key line')
  }
  if (inner !== type) throw new Error(`public key says ${type} but contains ${inner}`)
  if (type === ED25519) {
    const reader = new WireReader(blob)
    reader.string()
    if (reader.string().length !== 32 || reader.remaining !== 0)
      throw new Error('malformed ssh-ed25519 public key')
  }
  return { type, blob, comment, fingerprint: fingerprintOfBlob(blob) }
}

/** `SHA256:<base64 without padding>` of a public key line, as `ssh-keygen -lf` prints it. */
export function fingerprint(publicKey: string): string {
  return parsePublicKey(publicKey).fingerprint
}

/**
 * Reads the public half and comment of an unencrypted OpenSSH private key. Throws on encrypted
 * keys, mismatched check ints, keys whose public and private halves disagree, and other damage.
 */
export function parsePrivateKey(privateKey: string): SshPrivateKeyInfo {
  const text = privateKey.trim()
  if (!text.startsWith(BEGIN) || !text.endsWith(END)) throw new Error('not an OpenSSH private key')
  const data = new Uint8Array(
    Buffer.from(text.slice(BEGIN.length, -END.length).replace(/\s+/g, ''), 'base64'),
  )
  const reader = new WireReader(data)
  if (new TextDecoder().decode(reader.bytes(MAGIC.length)) !== MAGIC)
    throw new Error('not an openssh-key-v1 private key')
  const cipher = reader.text()
  const kdf = reader.text()
  reader.string()
  if (cipher !== 'none' || kdf !== 'none')
    throw new Error('encrypted SSH private keys are not supported')
  if (reader.uint32() !== 1)
    throw new Error('SSH private key files with several keys are not supported')
  const blob = reader.string()
  const section = new WireReader(reader.string())
  if (section.uint32() !== section.uint32()) throw new Error('SSH private key check ints differ')
  const type = section.text()
  if (type === ED25519) {
    const publicKey = section.string()
    const secret = section.string()
    if (publicKey.length !== 32 || secret.length !== 64)
      throw new Error('malformed ssh-ed25519 private key')
    const derived = createPublicKey(
      createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, secret.subarray(0, 32)]),
        format: 'der',
        type: 'pkcs8',
      }),
    ).export({ format: 'jwk' })
    if (Buffer.compare(Buffer.from(derived.x ?? '', 'base64url'), Buffer.from(publicKey)) !== 0)
      throw new Error('SSH private key does not match its public key')
    if (Buffer.compare(Buffer.from(ed25519Blob(publicKey)), Buffer.from(blob)) !== 0)
      throw new Error('SSH private key does not match its public key')
  } else {
    throw new Error(`unsupported SSH private key type: ${type}`)
  }
  const comment = section.text()
  const padding = section.rest()
  if (padding.some((byte, index) => byte !== index + 1))
    throw new Error('malformed SSH private key padding')
  return {
    type,
    publicKey: publicLine(type, blob, comment),
    comment,
    fingerprint: fingerprintOfBlob(blob),
  }
}
