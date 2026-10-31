import {
  adminGrants,
  createUser,
  findUser,
  issueUserLink,
  type ManageOptions,
} from '@holtkeeper/auth-users'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { User } from '@holtkeeper/store'

import { UsageError } from './audit.ts'
import { parseDuration } from './serve.ts'

/** Raw `users` flags as `parseArgs` returns them. */
export interface UsersFlags {
  email?: string | undefined
  admin?: boolean | undefined
  ttl?: string | undefined
  json?: boolean | undefined
}

const linkPurposes = {
  'login-link': 'login',
  'enroll-link': 'enroll',
  'recover-link': 'recover',
} as const
const defaultTtl = { login: '15m', enroll: '72h', recover: '72h' } as const

const describe = (user: User) =>
  [
    user.id,
    user.name,
    user.email ?? '-',
    user.grants.some((grant) => 'all' in grant.scope && grant.actions.includes('*'))
      ? 'admin'
      : `${user.grants.length} grant(s)`,
    user.disabled ? 'disabled' : 'enabled',
  ].join('\t')

/**
 * `holtkeeper users <list | add <name> | login-link <user> | enroll-link <user> |
 * recover-link <user>>` against the config's store, as `cli` in the activity log. Links point at
 * `server.publicUrl`; a login link signs its holder in once without a passkey.
 */
export async function usersCommand(
  config: HoltkeeperConfig,
  args: string[],
  flags: UsersFlags,
  out: (line: string) => void,
): Promise<number> {
  const server = config.server
  if (!server) throw new UsageError('users needs a config with a server section')
  const store = server.store
  const manage: ManageOptions = { store: store.users, activity: store.activity, actor: 'cli' }
  const [action, target] = args
  try {
    switch (action) {
      case 'list': {
        const users = await store.users.listUsers()
        if (flags.json) out(JSON.stringify(users, null, 2))
        else for (const user of users) out(describe(user))
        return 0
      }
      case 'add': {
        if (!target) throw new UsageError('users add expects a name, e.g. users add Claude --admin')
        const user = await createUser(manage, {
          name: target,
          ...(flags.email ? { email: flags.email } : {}),
          grants: flags.admin ? adminGrants : [],
        }).catch((error: unknown) => {
          throw new UsageError(error instanceof Error ? error.message : String(error))
        })
        out(flags.json ? JSON.stringify(user, null, 2) : describe(user))
        return 0
      }
      case 'login-link':
      case 'enroll-link':
      case 'recover-link': {
        if (!target) throw new UsageError(`users ${action} expects a user id, email or name`)
        if (!server.publicUrl) throw new UsageError(`users ${action} needs server.publicUrl`)
        const user = await findUser(store.users, target)
        if (!user) throw new UsageError(`no single user matches "${target}"`)
        if (user.disabled) throw new UsageError(`${user.name} is disabled`)
        const purpose = linkPurposes[action]
        const issued = await issueUserLink(manage, {
          user,
          purpose,
          origin: server.publicUrl,
          ttlMs: parseDuration('ttl', flags.ttl ?? defaultTtl[purpose]),
        })
        out(flags.json ? JSON.stringify(issued) : issued.link)
        return 0
      }
      default:
        throw new UsageError('users expects list, add, login-link, enroll-link or recover-link')
    }
  } finally {
    await store.close()
  }
}
