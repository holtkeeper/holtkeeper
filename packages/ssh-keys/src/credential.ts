import type { SshKeyScope, SshKeyUsage } from '@holtkeeper/forge'
import { z } from 'zod'

import { fingerprint, parsePrivateKey, type SshKeyPair } from './keys.ts'

/** Credential kind for SSH keys. */
export const SSH_CREDENTIAL_KIND = 'ssh'

export const sshKeyUsageSchema = z.enum(['auth', 'signing', 'auth_and_signing'])

export const sshKeyScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('deploy'), repo: z.string().min(1), canPush: z.boolean() }),
])

/** Where one key was registered: the config's forge id, the scope, and the forge's key id. */
export interface SshKeyRegistrationRef {
  forge: string
  scope: SshKeyScope
  id: string
}

export const sshKeyRegistrationRefSchema = z.object({
  forge: z.string().min(1),
  scope: sshKeyScopeSchema,
  id: z.string().min(1),
})

/**
 * Non-secret `options` of a credential of kind `ssh`; the private key is the sealed secret. A type
 * alias, so it is assignable to the credential service's `Record<string, unknown>` options.
 */
export type SshCredentialOptions = {
  publicKey: string
  fingerprint: string
  usage: SshKeyUsage
  registered: SshKeyRegistrationRef[]
  /** Pinned `known_hosts` contents for the forge's SSH endpoint. */
  knownHosts?: string
  /** Author and committer of commits signed with the key; the forge account's verified email. */
  identity?: SshCommitIdentity
}

/** Who signed commits are made by. */
export interface SshCommitIdentity {
  name: string
  email: string
}

export const sshCredentialOptionsSchema = z
  .object({
    publicKey: z.string().min(1),
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
    usage: sshKeyUsageSchema,
    registered: z.array(sshKeyRegistrationRefSchema),
    knownHosts: z.string().optional(),
    identity: z.object({ name: z.string().min(1), email: z.email() }).optional(),
  })
  .superRefine((options, context) => {
    let actual: string
    try {
      actual = fingerprint(options.publicKey)
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['publicKey'],
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (actual !== options.fingerprint)
      context.addIssue({
        code: 'custom',
        path: ['fingerprint'],
        message: 'does not match publicKey',
      })
  })

/**
 * `CreateCredentialInput` of `@holtkeeper/credentials` for an SSH key; `scope` is whatever the
 * credential service uses (an access `Scope`).
 */
export interface SshCredentialInput<Scope> {
  name: string
  kind: typeof SSH_CREDENTIAL_KIND
  url: string
  scope: Scope
  secret: string
  options: SshCredentialOptions
  expiresAt?: string
}

/** Input of `createSshCredentialInput`. */
export interface CreateSshCredentialOptions<Scope> {
  name: string
  /** The forge's base URL. */
  url: string
  scope: Scope
  keyPair: Pick<SshKeyPair, 'publicKey' | 'privateKey' | 'fingerprint'>
  usage: SshKeyUsage
  registered?: SshKeyRegistrationRef[]
  knownHosts?: string
  identity?: SshCommitIdentity
  expiresAt?: string
}

/** A credential input that stores the private key as the secret and the rest as `options`. */
export function createSshCredentialInput<Scope>(
  input: CreateSshCredentialOptions<Scope>,
): SshCredentialInput<Scope> {
  const options: SshCredentialOptions = {
    publicKey: input.keyPair.publicKey,
    fingerprint: input.keyPair.fingerprint,
    usage: input.usage,
    registered: input.registered ?? [],
    ...(input.knownHosts === undefined ? {} : { knownHosts: input.knownHosts }),
    ...(input.identity === undefined ? {} : { identity: input.identity }),
  }
  return {
    name: input.name,
    kind: SSH_CREDENTIAL_KIND,
    url: input.url,
    scope: input.scope,
    secret: input.keyPair.privateKey,
    options: sshCredentialOptionsSchema.parse(options),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  }
}

/**
 * A `CredentialOptionsValidator` for `@holtkeeper/credentials`: checks `ssh` options and returns
 * `field: message` problems; `undefined` for other kinds.
 */
export function validateSshCredentialOptions(
  kind: string,
  options: Record<string, unknown> | undefined,
): string[] | undefined {
  if (kind !== SSH_CREDENTIAL_KIND) return undefined
  const parsed = sshCredentialOptionsSchema.safeParse(options ?? {})
  if (parsed.success) return []
  return parsed.error.issues.map(
    (issue) => `options.${issue.path.join('.') || '(root)'}: ${issue.message}`,
  )
}

/** A stored SSH credential, ready to hand to git. */
export interface SshCredential extends SshCredentialOptions {
  privateKey: string
}

/**
 * Combines a revealed secret with the credential's options. Throws when the options are invalid
 * or the private key does not belong to `options.publicKey`.
 */
export function readSshCredential(secret: string, options: unknown): SshCredential {
  const parsed = sshCredentialOptionsSchema.parse(options)
  if (parsePrivateKey(secret).fingerprint !== parsed.fingerprint)
    throw new Error('the SSH private key does not match the credential public key')
  return { ...parsed, privateKey: secret }
}
