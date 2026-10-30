import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parsePrivateKey } from '@holtkeeper/ssh-keys'

/** SSH transport for clone, fetch and push. Key material is written only to a private temp dir per git call. */
export interface SshTransport {
  /** Unencrypted OpenSSH private key. */
  privateKey: string
  /** `known_hosts` contents with the pinned host keys; hosts not in it are refused. */
  knownHosts: string
  /** SSH user. Default `git`. */
  user?: 'git'
}

/** Signs the commits a checkout makes with an SSH key (`gpg.format=ssh`). */
export interface CommitSigning {
  privateKey: string
  /** The public half, one OpenSSH line; it must belong to `privateKey`. */
  publicKey: string
  /** Committer and author identity; forges show a commit as verified when it matches the key's account. */
  name: string
  email: string
}

/**
 * The SSH form of a clone URL: `https://host/path.git` becomes `git@host:path.git`. URLs that
 * already use SSH (`ssh://` or `user@host:path`) are returned unchanged. A port or path prefix of
 * the HTTPS URL is dropped, because SSH endpoints rarely share them; pass the SSH URL directly then.
 */
export function sshCloneUrl(cloneUrl: string, user = 'git'): string {
  if (/^ssh:\/\//i.test(cloneUrl) || /^[\w.-]+@[^:/]+:/.test(cloneUrl)) return cloneUrl
  const url = new URL(cloneUrl)
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`cannot derive an SSH URL from ${url.protocol} clone URLs`)
  const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  return `${user}@${url.hostname}:${path.endsWith('.git') ? path : `${path}.git`}`
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** The `GIT_SSH_COMMAND` that uses only `keyFile` and trusts only hosts in `knownHostsFile`. */
export function gitSshCommand(keyFile: string, knownHostsFile: string): string {
  return [
    'ssh',
    '-i',
    quote(keyFile),
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `UserKnownHostsFile=${quote(knownHostsFile)}`,
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'BatchMode=yes',
    '-F',
    '/dev/null',
  ].join(' ')
}

const withNewline = (text: string) => (text.endsWith('\n') ? text : `${text}\n`)

/** A directory only the current user can read, holding secrets for one git call. */
async function privateDir<T>(parent: string | undefined, task: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(parent ?? tmpdir(), 'holtkeeper-key-'))
  try {
    await chmod(dir, 0o700)
    return await task(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const writePrivate = async (path: string, content: string) => {
  await writeFile(path, withNewline(content), { mode: 0o600 })
  await chmod(path, 0o600)
}

/**
 * Runs `task` with environment variables that make git use `ssh` for the remote; the key and
 * known hosts files exist only while `task` runs.
 */
export function withSshEnv<T>(
  ssh: SshTransport,
  parent: string | undefined,
  task: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  return privateDir(parent, async (dir) => {
    const key = join(dir, 'id')
    const knownHosts = join(dir, 'known_hosts')
    await writePrivate(key, ssh.privateKey)
    await writePrivate(knownHosts, ssh.knownHosts)
    return task({ GIT_SSH_COMMAND: gitSshCommand(key, knownHosts), GIT_SSH_VARIANT: 'ssh' })
  })
}

/** Checks that a signing key pair belongs together; throws otherwise. */
export function assertSigningKey(signing: CommitSigning): void {
  const derived = parsePrivateKey(signing.privateKey).publicKey.split(' ').slice(0, 2).join(' ')
  if (derived !== signing.publicKey.trim().split(/\s+/).slice(0, 2).join(' '))
    throw new Error('the signing private key does not match its public key')
}

/**
 * Runs `task` with `git -c` arguments that sign commits with `signing`; the key file exists only
 * while `task` runs.
 */
export function withSigningConfig<T>(
  signing: CommitSigning,
  parent: string | undefined,
  task: (config: string[]) => Promise<T>,
): Promise<T> {
  return privateDir(parent, async (dir) => {
    const key = join(dir, 'signing')
    await writePrivate(key, signing.privateKey)
    await writeFile(`${key}.pub`, withNewline(signing.publicKey))
    return task([
      '-c',
      'gpg.format=ssh',
      '-c',
      `user.signingkey=${key}`,
      '-c',
      'commit.gpgsign=true',
      '-c',
      'gpg.ssh.program=ssh-keygen',
    ])
  })
}
