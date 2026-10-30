// oxlint-disable no-await-in-loop -- registrations run in order so a failure can be rolled back precisely
import type { GitForge } from '@holtkeeper/forge'

import type { SshCredentialOptions, SshKeyRegistrationRef } from './credential.ts'
import { generateKeyPair, type SshKeyPair } from './keys.ts'

/** Input of `rotateSshKey`. */
export interface RotateSshKeyInput {
  /** Options of the credential being rotated; the new key is registered in the same places. */
  current: SshCredentialOptions
  /** Forge by the config's forge id used in `registered[].forge`. */
  forge(id: string): GitForge
  /** Title of the new key on the forge. */
  title: string
  /** Comment of the new public key. */
  comment?: string
  /** ISO 8601 expiry of the new key on the forge. */
  expiresAt?: string
  /**
   * Stores the new private key (as the credential secret) and options. The old key is removed
   * only after this resolves; when it rejects the new registrations are removed again.
   */
  activate(next: { secret: string; options: SshCredentialOptions }): Promise<void>
  /** Default: a new Ed25519 key. */
  generate?: () => SshKeyPair
}

/** Outcome of `rotateSshKey`. */
export interface RotateSshKeyResult {
  options: SshCredentialOptions
  /** Old registrations that were removed. */
  removed: SshKeyRegistrationRef[]
  /** Old registrations that could not be removed; the new key is active regardless. */
  failedRemovals: { ref: SshKeyRegistrationRef; error: string }[]
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function sshForge(input: RotateSshKeyInput, id: string) {
  const forge = input.forge(id)
  if (!forge.registerSshKey || !forge.removeSshKey)
    throw new Error(`forge "${id}" cannot register and remove SSH keys`)
  return {
    register: forge.registerSshKey.bind(forge),
    remove: forge.removeSshKey.bind(forge),
  }
}

/**
 * Replaces an SSH key without a window in which nothing works: generates a new key, registers it
 * everywhere the old one is registered, calls `activate`, then removes the old registrations.
 * Rejects (after removing what it registered) when a registration or `activate` fails; by then
 * the old key is untouched. Failing to remove an old registration does not reject.
 */
export async function rotateSshKey(input: RotateSshKeyInput): Promise<RotateSshKeyResult> {
  const { current } = input
  const pair = (
    input.generate ?? (() => generateKeyPair({ type: 'ed25519', comment: input.comment ?? '' }))
  )()
  const registered: SshKeyRegistrationRef[] = []

  const rollback = async () => {
    for (const ref of registered) {
      try {
        await sshForge(input, ref.forge).remove(ref.id, ref.scope)
      } catch {
        // The original error matters more; a leftover key is harmless without its private half.
      }
    }
  }

  try {
    for (const old of current.registered) {
      const { id } = await sshForge(input, old.forge).register({
        title: input.title,
        publicKey: pair.publicKey,
        usage: current.usage,
        scope: old.scope,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      })
      registered.push({ forge: old.forge, scope: old.scope, id })
    }
    const options: SshCredentialOptions = {
      ...current,
      publicKey: pair.publicKey,
      fingerprint: pair.fingerprint,
      registered,
    }
    await input.activate({ secret: pair.privateKey, options })

    const removed: SshKeyRegistrationRef[] = []
    const failedRemovals: RotateSshKeyResult['failedRemovals'] = []
    for (const old of current.registered) {
      try {
        await sshForge(input, old.forge).remove(old.id, old.scope)
        removed.push(old)
      } catch (error) {
        failedRemovals.push({ ref: old, error: errorText(error) })
      }
    }
    return { options, removed, failedRemovals }
  } catch (error) {
    await rollback()
    throw error
  }
}
