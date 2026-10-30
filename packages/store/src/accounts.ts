import type { ExternalAccount, ExternalAccountStore } from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

/** `ExternalAccountStore.put` was asked to link a `(provider, externalId)` another link holds. */
export class ExternalAccountConflictError extends Error {
  readonly provider: string
  readonly externalId: string

  constructor(provider: string, externalId: string) {
    super(`${provider} account ${externalId} is already linked`)
    this.name = 'ExternalAccountConflictError'
    this.provider = provider
    this.externalId = externalId
  }
}

/** The in-memory `ExternalAccountStore`. */
export function memoryExternalAccounts(): ExternalAccountStore & {
  /** Drops every link of a principal; called when its user is removed. */
  removeUser(userId: string): void
} {
  const accounts = new Map<string, ExternalAccount>()
  const all = () => [...accounts.values()]
  return {
    get: async (id) => clone(accounts.get(id)),
    find: async (provider, externalId) =>
      clone(all().find((a) => a.provider === provider && a.externalId === externalId)),
    listByUser: async (userId) =>
      all()
        .filter((a) => a.userId === userId)
        .map(clone),
    list: async (provider) =>
      all()
        .filter((a) => provider === undefined || a.provider === provider)
        .map(clone),
    async put(account) {
      const holder = all().find(
        (a) => a.provider === account.provider && a.externalId === account.externalId,
      )
      if (holder && holder.id !== account.id)
        throw new ExternalAccountConflictError(account.provider, account.externalId)
      accounts.set(account.id, clone(account))
    },
    remove: async (id) => void accounts.delete(id),
    removeUser(userId) {
      for (const [id, account] of accounts) if (account.userId === userId) accounts.delete(id)
    },
  }
}
