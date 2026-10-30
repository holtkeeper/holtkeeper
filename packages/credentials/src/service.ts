import type { ActivityStore, CredentialStore, StoredCredential } from '@holtkeeper/store'
import type { Vault } from '@holtkeeper/vault'

import { CredentialInputError, CredentialNotFoundError } from './errors.ts'
import type {
  CreateCredentialInput,
  CredentialOptionsValidator,
  CredentialView,
  RotationResult,
  TokenRotator,
  UpdateCredentialInput,
} from './types.ts'
import { parseCredentialInput } from './validate.ts'

/** Lifetime requested by a manual `rotate` of a credential that has no rotation policy. */
export const DEFAULT_LIFETIME_DAYS = 90

/** Actor recorded for changes nobody asked for, such as scheduled rotations. */
export const SYSTEM_ACTOR = 'system'

const DAY_MS = 86_400_000

export interface CredentialServiceOptions {
  credentials: CredentialStore
  /** Receives `credential.*` events. Without it nothing is logged. */
  activity?: ActivityStore
  vault: Vault
  /** At most one per kind; later ones win. */
  rotators?: TokenRotator[]
  /**
   * Checks kind-specific `options` on create and update (with the resulting kind and options);
   * problems throw `CredentialInputError`. Without it any JSON object is accepted.
   */
  validateOptions?: CredentialOptionsValidator
  now?: () => Date
}

/**
 * Manages stored credentials. Secrets are sealed by the vault before they reach the store and
 * never appear in views, activity events or error messages.
 */
export interface CredentialService {
  list(): Promise<CredentialView[]>
  get(id: string): Promise<CredentialView | undefined>
  /** Validates input (throws `CredentialInputError`) and stores a new credential. */
  create(input: CreateCredentialInput, actor: string): Promise<CredentialView>
  /** Changes the given fields. A new secret is sealed and clears `lastError`. Throws `CredentialNotFoundError`. */
  update(id: string, input: UpdateCredentialInput, actor: string): Promise<CredentialView>
  /** Throws `CredentialNotFoundError`. */
  remove(id: string, actor: string): Promise<void>
  /** The plaintext secret. For internal callers that use the credential; never expose it over an API. */
  reveal(id: string): Promise<string>
  /**
   * Replaces the secret with a fresh token from the kind's rotator and stores it. A kind without a
   * rotator throws `CredentialInputError` and changes nothing; any other failure records `lastError`
   * and rethrows. Concurrent calls for one id share a single rotation.
   */
  rotate(id: string, actor: string): Promise<CredentialView>
  /**
   * Rotates, one after another, every rotatable credential with rotation enabled whose `expiresAt` is within
   * `daysBefore` days or already past. Credentials without `expiresAt` are skipped. Never throws for
   * a single failed rotation; failures are in the results.
   */
  rotateDue(): Promise<RotationResult[]>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Creates a `CredentialService` over the given store, vault and rotators. */
export function createCredentialService(options: CredentialServiceOptions): CredentialService {
  const { credentials, activity, vault, now = () => new Date() } = options
  const rotators = new Map((options.rotators ?? []).map((rotator) => [rotator.kind, rotator]))
  const inFlight = new Map<string, Promise<CredentialView>>()

  const toView = ({ secret: _secret, ...view }: StoredCredential): CredentialView => ({
    ...view,
    rotatable: rotators.has(view.kind),
  })

  const checkOptions = (kind: string, value: Record<string, unknown> | undefined) => {
    const issues = options.validateOptions?.(kind, value) ?? []
    if (issues.length > 0) throw new CredentialInputError(issues)
  }

  const log = async (
    actor: string,
    action: string,
    credential: StoredCredential,
    details?: object,
  ) => {
    await activity?.append({
      at: now().toISOString(),
      actor,
      action: `credential.${action}`,
      subject: credential.id,
      details: { name: credential.name, kind: credential.kind, ...details },
    })
  }

  const load = async (id: string) => {
    const credential = await credentials.get(id)
    if (!credential) throw new CredentialNotFoundError(id)
    return credential
  }

  // Inspection only fills in metadata, so a failure must not block storing the credential.
  const inspectExpiry = async (kind: string, url: string, token: string) => {
    const rotator = rotators.get(kind)
    if (!rotator?.inspect) return undefined
    try {
      const { expiresAt } = await rotator.inspect({ url, token })
      return expiresAt && !Number.isNaN(Date.parse(expiresAt))
        ? new Date(expiresAt).toISOString()
        : undefined
    } catch {
      return undefined
    }
  }

  const doRotate = async (id: string, actor: string): Promise<CredentialView> => {
    const credential = await load(id)
    const rotator = rotators.get(credential.kind)
    if (!rotator)
      throw new CredentialInputError([`kind: no token rotator for kind "${credential.kind}"`])
    let next: StoredCredential
    let rotated = false
    try {
      const token = await vault.open(credential.secret)
      const lifetimeDays = credential.rotation?.lifetimeDays ?? DEFAULT_LIFETIME_DAYS
      const result = await rotator.rotate({ url: credential.url, token, lifetimeDays })
      rotated = true
      const at = now().toISOString()
      const { lastError: _lastError, ...rest } = credential
      next = {
        ...rest,
        secret: await vault.seal(result.token),
        expiresAt: new Date(result.expiresAt).toISOString(),
        lastRotatedAt: at,
        updatedAt: at,
      }
      await credentials.put(next)
    } catch (error) {
      // Once the service has rotated, the old token is revoked; the stored secret is now useless.
      const message = rotated
        ? `token was rotated but the new one could not be stored: ${messageOf(error)}`
        : messageOf(error)
      const failed = { ...credential, lastError: message, updatedAt: now().toISOString() }
      await credentials.put(failed).catch(() => {})
      await log(actor, 'rotation_failed', failed, { error: message }).catch(() => {})
      throw error
    }
    await log(actor, 'rotated', next, { expiresAt: next.expiresAt })
    return toView(next)
  }

  const rotate = (id: string, actor: string) => {
    const running = inFlight.get(id)
    if (running) return running
    const promise = doRotate(id, actor).finally(() => inFlight.delete(id))
    inFlight.set(id, promise)
    return promise
  }

  return {
    list: async () => (await credentials.list()).map(toView),

    async get(id) {
      const credential = await credentials.get(id)
      return credential && toView(credential)
    },

    async create(input, actor) {
      const parsed = parseCredentialInput(input)
      const credentialOptions =
        parsed.options && Object.keys(parsed.options).length > 0 ? parsed.options : undefined
      checkOptions(parsed.kind, credentialOptions)
      const at = now().toISOString()
      const credential: StoredCredential = {
        id: crypto.randomUUID(),
        name: parsed.name,
        kind: parsed.kind,
        url: parsed.url,
        scope: parsed.scope,
        secret: await vault.seal(parsed.secret),
        createdAt: at,
        updatedAt: at,
      }
      const expiresAt =
        parsed.expiresAt ?? (await inspectExpiry(parsed.kind, parsed.url, parsed.secret))
      if (expiresAt) credential.expiresAt = expiresAt
      if (parsed.rotation) credential.rotation = parsed.rotation
      if (credentialOptions) credential.options = credentialOptions
      await credentials.put(credential)
      await log(actor, 'created', credential)
      return toView(credential)
    },

    async update(id, input, actor) {
      const parsed = parseCredentialInput(input, true)
      const current = await load(id)
      const { secret, options: newOptions, ...fields } = parsed
      const next: StoredCredential = { ...current, ...fields, updatedAt: now().toISOString() }
      if (newOptions !== undefined) {
        if (Object.keys(newOptions).length > 0) next.options = newOptions
        else delete next.options
      }
      if (parsed.kind !== undefined || newOptions !== undefined)
        checkOptions(next.kind, next.options)
      if (secret !== undefined) {
        next.secret = await vault.seal(secret)
        delete next.lastError
        const expiresAt = parsed.expiresAt ?? (await inspectExpiry(next.kind, next.url, secret))
        if (expiresAt) next.expiresAt = expiresAt
        else delete next.expiresAt
      }
      await credentials.put(next)
      await log(actor, 'updated', next, { fields: Object.keys(parsed).toSorted() })
      return toView(next)
    },

    async remove(id, actor) {
      const credential = await load(id)
      await credentials.remove(id)
      await log(actor, 'removed', credential)
    },

    reveal: async (id) => vault.open((await load(id)).secret),

    rotate,

    async rotateDue() {
      const at = now().getTime()
      const due = (await credentials.list()).filter(
        ({ kind, rotation, expiresAt }) =>
          rotators.has(kind) &&
          rotation?.enabled &&
          expiresAt !== undefined &&
          Date.parse(expiresAt) - at <= rotation.daysBefore * DAY_MS,
      )
      const results: RotationResult[] = []
      for (const { id } of due) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one at a time keeps load on the provider low
          await rotate(id, SYSTEM_ACTOR)
          results.push({ id, ok: true })
        } catch (error) {
          results.push({ id, ok: false, error: messageOf(error) })
        }
      }
      return results
    },
  }
}
