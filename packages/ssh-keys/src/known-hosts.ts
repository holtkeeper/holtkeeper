import { tmpdir } from 'node:os'

import { type CommandRunner, runChecked } from '@holtkeeper/exec'

import { parsePublicKey } from './keys.ts'

/** One host key line of a `known_hosts` file. */
export interface HostKey {
  /** The host pattern exactly as written, e.g. `gitlab.example.com` or `[git.example.com]:2222`. */
  hosts: string
  /** Algorithm, e.g. `ssh-ed25519`. */
  type: string
  /** Base64 key blob. */
  key: string
  fingerprint: string
}

/** No scanned host key matched the expected fingerprints. */
export class HostKeyMismatchError extends Error {
  override name = 'HostKeyMismatchError'
  readonly host: string
  readonly offered: string[]

  constructor(host: string, offered: string[]) {
    super(
      `none of the host keys offered by ${host} (${offered.join(', ') || 'none'}) matches an expected fingerprint`,
    )
    this.host = host
    this.offered = offered
  }
}

/** The `known_hosts` name of a host: bare for port 22, `[host]:port` otherwise. */
export function knownHostsName(host: string, port = 22): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/**
 * Plain host key lines of a `known_hosts` file. Comments, blank lines, marker lines
 * (`@cert-authority`, `@revoked`) and lines that do not parse are skipped.
 */
export function parseKnownHosts(text: string): HostKey[] {
  const keys: HostKey[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('@')) continue
    const [hosts, type, key] = line.split(/\s+/)
    if (!hosts || !type || !key) continue
    try {
      keys.push({ hosts, type, key, fingerprint: parsePublicKey(`${type} ${key}`).fingerprint })
    } catch {
      continue
    }
  }
  return keys
}

/** `known_hosts` file contents for `keys`, one line each, ending with a newline. */
export function formatKnownHosts(keys: readonly HostKey[]): string {
  return keys.map((key) => `${key.hosts} ${key.type} ${key.key}\n`).join('')
}

/** Input of `scanHostKeys` and `pinHostKeys`. */
export interface ScanHostKeysOptions {
  host: string
  /** Default 22. */
  port?: number
  runner: CommandRunner
  /** Default `ed25519`, `ecdsa` and `rsa`. */
  types?: string[]
  /** Connect timeout passed to `ssh-keyscan -T`. Default 10. */
  timeoutSeconds?: number
  signal?: AbortSignal
}

const validHost = (host: string) => /^[A-Za-z0-9.:_-]+$/.test(host) && !host.startsWith('-')

/**
 * Asks the host for its keys with `ssh-keyscan`. The answer is unauthenticated: trust it only
 * after comparing fingerprints with ones obtained out of band (`pinHostKeys` does that).
 * Rejects when the host offers no key.
 */
export async function scanHostKeys(options: ScanHostKeysOptions): Promise<HostKey[]> {
  const { host, port = 22, runner } = options
  if (!validHost(host)) throw new Error(`invalid host name: ${host}`)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid port: ${port}`)
  const command = [
    'ssh-keyscan',
    '-T',
    String(options.timeoutSeconds ?? 10),
    '-t',
    (options.types ?? ['ed25519', 'ecdsa', 'rsa']).join(','),
    ...(port === 22 ? [] : ['-p', String(port)]),
    host,
  ]
  // ssh-keyscan exits 0 even when the host is unreachable, so an empty answer is the failure signal.
  const { stdout } = await runChecked(runner, command, {
    cwd: tmpdir(),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const keys = parseKnownHosts(stdout)
  if (keys.length === 0)
    throw new Error(`ssh-keyscan found no host keys for ${knownHostsName(host, port)}`)
  return keys
}

/** A pinned `known_hosts` file and the keys in it. */
export interface PinnedHostKeys {
  knownHosts: string
  keys: HostKey[]
}

/**
 * Scans the host and keeps the keys to trust. With `fingerprints` (e.g. from the forge's
 * documentation page) only matching keys are kept and `HostKeyMismatchError` is thrown when none
 * match; without them every offered key is trusted on first use.
 */
export async function pinHostKeys(
  options: ScanHostKeysOptions & { fingerprints?: string[] },
): Promise<PinnedHostKeys> {
  const offered = await scanHostKeys(options)
  const expected = options.fingerprints
  const keys = expected ? offered.filter((key) => expected.includes(key.fingerprint)) : offered
  if (keys.length === 0)
    throw new HostKeyMismatchError(
      knownHostsName(options.host, options.port),
      offered.map((key) => key.fingerprint),
    )
  return { knownHosts: formatKnownHosts(keys), keys }
}
