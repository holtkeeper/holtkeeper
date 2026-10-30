import { everything } from '@holtkeeper/access'
import type { ForgeSshKeyInput, ForgeSshKeyView } from '@holtkeeper/api'
import type { CredentialService, CredentialView } from '@holtkeeper/credentials'
import type { CommandRunner } from '@holtkeeper/exec'
import type { GitForge, SshKeyUsage } from '@holtkeeper/forge'
import type { GitKeyFor } from '@holtkeeper/jobs'
import {
  type SshCommitIdentity,
  createSshCredentialInput,
  generateKeyPair,
  pinHostKeys,
  readSshCredential,
  rotateSshKey,
  sshCredentialOptionsSchema,
} from '@holtkeeper/ssh-keys'
import type { ConfigDocument, ConfigStore, ForgeSshKey } from '@holtkeeper/store'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const DEFAULT_LIFETIME_DAYS = 365

/** The panel view of a forge's SSH key; `undefined` when its credential is gone or unreadable. */
export function sshKeyView(
  sshKey: ForgeSshKey,
  credential: CredentialView | undefined,
): ForgeSshKeyView | undefined {
  const parsed = sshCredentialOptionsSchema.safeParse(credential?.options)
  if (!credential || !parsed.success) return undefined
  const options = parsed.data
  return {
    credentialId: sshKey.credentialId,
    createdAt: sshKey.createdAt,
    publicKey: options.publicKey,
    fingerprint: options.fingerprint,
    usage: options.usage,
    ...(credential.expiresAt !== undefined && { expiresAt: credential.expiresAt }),
    ...(options.identity && { identity: options.identity }),
    hostKeysPinned: Boolean(options.knownHosts),
  }
}

export interface IssueSshKeyInput {
  forgeId: string
  doc: ConfigDocument<'forge'>
  forge: GitForge
  credentials: CredentialService
  input: ForgeSshKeyInput
  actor: string
  /** Runs `ssh-keyscan`. */
  runner: CommandRunner
  now: Date
}

const readOptions = async (credentials: CredentialService, id: string) => {
  const parsed = sshCredentialOptionsSchema.safeParse((await credentials.get(id))?.options)
  return parsed.success ? parsed.data : undefined
}

async function identityFor(
  forge: GitForge,
  input: ForgeSshKeyInput,
  current: SshCommitIdentity | undefined,
  notes: string[],
): Promise<SshCommitIdentity | undefined> {
  if (input.identity) return input.identity
  if (current) return current
  try {
    const user = await forge.getCurrentUser?.()
    if (user?.email) return { name: user.name, email: user.email }
    notes.push('the forge account has no email to sign commits with; set one to enable signing')
  } catch (error) {
    notes.push(`could not read the forge account: ${messageOf(error)}`)
  }
  return undefined
}

async function knownHostsFor(
  url: string,
  runner: CommandRunner,
  notes: string[],
): Promise<string | undefined> {
  try {
    return (await pinHostKeys({ host: new URL(url).hostname, runner })).knownHosts
  } catch (error) {
    notes.push(`host keys not pinned, git keeps using HTTPS: ${messageOf(error)}`)
    return undefined
  }
}

/**
 * Issues an SSH key on the account behind the forge's token and stores it as an `ssh` credential
 * with the token credential's scope, or rotates the key the forge already has. The private key
 * never leaves the server. Host keys are trusted on first use.
 */
export async function issueForgeSshKey(
  options: IssueSshKeyInput,
): Promise<{ sshKey: ForgeSshKey; notes: string[] }> {
  const { forgeId, doc, forge, credentials, input, actor } = options
  if (!forge.registerSshKey || !forge.removeSshKey)
    throw new Error(`forge ${forgeId} cannot register SSH keys`)
  const notes: string[] = []
  const days = input.expiresInDays ?? DEFAULT_LIFETIME_DAYS
  const expiresAt = new Date(options.now.getTime() + days * 86_400_000).toISOString()
  const host = new URL(doc.data.url).hostname
  const title = `holtkeeper (${forgeId})`
  const comment = `holtkeeper@${host}`
  const existingId = doc.data.sshKey?.credentialId
  const current = existingId ? await readOptions(credentials, existingId) : undefined
  const usage: SshKeyUsage = input.usage ?? current?.usage ?? 'auth_and_signing'
  const identity = await identityFor(forge, input, current?.identity, notes)
  const knownHosts =
    (await knownHostsFor(doc.data.url, options.runner, notes)) ?? current?.knownHosts

  if (existingId && current) {
    const result = await rotateSshKey({
      current: {
        ...current,
        usage,
        ...(identity && { identity }),
        ...(knownHosts !== undefined && { knownHosts }),
      },
      forge: () => forge,
      title,
      comment,
      expiresAt,
      activate: async (next) => {
        await credentials.update(existingId, { ...next, expiresAt }, actor)
      },
    })
    for (const failed of result.failedRemovals)
      notes.push(`old key ${failed.ref.id} is still on the forge: ${failed.error}`)
    return { sshKey: { credentialId: existingId, createdAt: options.now.toISOString() }, notes }
  }

  const pair = generateKeyPair({ type: 'ed25519', comment })
  const { id } = await forge.registerSshKey({
    title,
    publicKey: pair.publicKey,
    usage,
    expiresAt,
    scope: { kind: 'user' },
  })
  const scope = (await credentials.get(doc.data.credentialId))?.scope ?? everything
  try {
    const created = await credentials.create(
      createSshCredentialInput({
        name: `${forgeId} SSH key`,
        url: doc.data.url,
        scope,
        keyPair: pair,
        usage,
        registered: [{ forge: forgeId, scope: { kind: 'user' }, id }],
        expiresAt,
        ...(knownHosts !== undefined && { knownHosts }),
        ...(identity && { identity }),
      }),
      actor,
    )
    return { sshKey: { credentialId: created.id, createdAt: options.now.toISOString() }, notes }
  } catch (error) {
    await forge.removeSshKey(id, { kind: 'user' }).catch(() => undefined)
    throw error
  }
}

/**
 * Removes the key from every place it is registered and deletes its credential. Registrations that
 * cannot be removed are reported, not thrown: the credential is gone, so nothing uses them.
 */
export async function removeForgeSshKey(options: {
  sshKey: ForgeSshKey
  forge: GitForge | undefined
  credentials: CredentialService
  actor: string
}): Promise<string[]> {
  const { sshKey, forge, credentials, actor } = options
  const errors: string[] = []
  const current = await readOptions(credentials, sshKey.credentialId)
  for (const ref of current?.registered ?? []) {
    try {
      if (!forge?.removeSshKey) throw new Error('the forge cannot remove SSH keys')
      // oxlint-disable-next-line no-await-in-loop -- a key has one or two registrations
      await forge.removeSshKey(ref.id, ref.scope)
    } catch (error) {
      errors.push(`key ${ref.id}: ${messageOf(error)}`)
    }
  }
  if (await credentials.get(sshKey.credentialId))
    await credentials.remove(sshKey.credentialId, actor)
  return errors
}

/** The SSH key of each panel forge, for job checkouts; file forges have none. */
export function forgeGitKeys(deps: {
  store: { config?: ConfigStore }
  credentials: CredentialService
}): GitKeyFor {
  return async (forgeId) => {
    const doc = await deps.store.config?.get('forge', forgeId)
    const id = doc?.data.sshKey?.credentialId
    const view = id ? await deps.credentials.get(id) : undefined
    if (!id || !view) return undefined
    return readSshCredential(await deps.credentials.reveal(id), view.options)
  }
}
