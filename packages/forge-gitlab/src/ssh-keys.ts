import type { GitForge, SshKeyRecord, SshKeyUsage } from '@holtkeeper/forge'
import { z } from 'zod'

import { encode, type GitLabClient } from './http.ts'

const userKeySchema = z.object({
  id: z.number(),
  title: z.string(),
  key: z.string(),
  created_at: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  usage_type: z.enum(['auth', 'signing', 'auth_and_signing']).optional(),
})

const deployKeySchema = z.object({
  id: z.number(),
  title: z.string(),
  key: z.string(),
  created_at: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  can_push: z.boolean().optional(),
})

const anySchema = z.unknown()

const project = (repo: string) => `projects/${encode(repo)}`

const keyId = (id: string) => {
  if (!/^\d+$/.test(id)) throw new Error(`GitLab SSH key ids are numeric, got "${id}"`)
  return id
}

const optional = (key: string, value: string | null | undefined): Record<string, string> =>
  value === null || value === undefined ? {} : { [key]: value }

const fromUserKey = (key: z.infer<typeof userKeySchema>): SshKeyRecord => ({
  id: String(key.id),
  title: key.title,
  publicKey: key.key,
  // Keys created before GitLab 15.7 have no usage type; they work for both.
  usage: key.usage_type ?? 'auth_and_signing',
  ...optional('expiresAt', key.expires_at),
  ...optional('createdAt', key.created_at),
})

const fromDeployKey = (key: z.infer<typeof deployKeySchema>): SshKeyRecord => ({
  id: String(key.id),
  title: key.title,
  publicKey: key.key,
  usage: 'auth',
  canPush: key.can_push ?? false,
  ...optional('expiresAt', key.expires_at),
  ...optional('createdAt', key.created_at),
})

const deployUsage = (usage: SshKeyUsage) => {
  if (usage !== 'auth')
    throw new Error('GitLab deploy keys can only authenticate; use usage "auth"')
}

/**
 * The `GitForge` SSH key methods over GitLab REST v4. User keys belong to the user behind the
 * token (`/user/keys`, with `usage_type`); deploy keys are per project (`/projects/:id/deploy_keys`).
 */
export function gitlabSshKeyMethods(
  client: GitLabClient,
): Required<Pick<GitForge, 'registerSshKey' | 'listSshKeys' | 'removeSshKey' | 'enableDeployKey'>> {
  return {
    async registerSshKey(key) {
      const base = {
        title: key.title,
        key: key.publicKey,
        ...optional('expires_at', key.expiresAt),
      }
      if (key.scope.kind === 'user') {
        const created = await client.json('POST', 'user/keys', userKeySchema, {
          body: { ...base, usage_type: key.usage },
        })
        return { id: String(created.id) }
      }
      deployUsage(key.usage)
      const created = await client.json(
        'POST',
        `${project(key.scope.repo)}/deploy_keys`,
        deployKeySchema,
        { body: { ...base, can_push: key.scope.canPush } },
      )
      return { id: String(created.id) }
    },

    async listSshKeys(scope) {
      const keys: SshKeyRecord[] = []
      if (scope.kind === 'user') {
        for await (const key of client.paginate('user/keys', userKeySchema))
          keys.push(fromUserKey(key))
      } else {
        for await (const key of client.paginate(
          `${project(scope.repo)}/deploy_keys`,
          deployKeySchema,
        ))
          keys.push(fromDeployKey(key))
      }
      return keys
    },

    async removeSshKey(id, scope) {
      await client.text(
        'DELETE',
        scope.kind === 'user'
          ? `user/keys/${keyId(id)}`
          : `${project(scope.repo)}/deploy_keys/${keyId(id)}`,
      )
    },

    async enableDeployKey(id, scope) {
      const path = `${project(scope.repo)}/deploy_keys/${keyId(id)}`
      await client.json('POST', `${path}/enable`, anySchema)
      // Enabling never grants write access, so `can_push` is set separately.
      if (scope.canPush) await client.json('PUT', path, anySchema, { body: { can_push: true } })
    },
  }
}
