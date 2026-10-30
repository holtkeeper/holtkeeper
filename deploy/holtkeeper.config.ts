import { passwordAuth } from '@holtkeeper/auth-password'
import { defineConfig } from '@holtkeeper/core'
import { env } from '@holtkeeper/forge'
import { gitlab } from '@holtkeeper/forge-gitlab'
import { postgresStore } from '@holtkeeper/store-postgres'
import { sqliteStore } from '@holtkeeper/store-sqlite'

/**
 * Container config shared by `deploy/docker-compose.yml` and the Helm chart. Mounted read-only at
 * /app/config/holtkeeper.config.ts; every secret comes from the environment.
 *
 * - `HOLTKEEPER_DATABASE_URL` set: Postgres (required for more than one process), else SQLite in /data.
 * - `HOLTKEEPER_S3_BUCKET` set: artifacts in any S3-compatible storage (required for more than one process), else /data.
 */
const multiProcess = Boolean(process.env.HOLTKEEPER_DATABASE_URL)
const port = Number(process.env.HOLTKEEPER_PORT ?? 7420)

export default defineConfig({
  forges: process.env.GITLAB_URL
    ? { work: gitlab({ url: process.env.GITLAB_URL, token: env('GITLAB_TOKEN') }) }
    : {},
  groups: {},
  server: {
    auth: passwordAuth({
      password: env('HOLTKEEPER_ROOT_PASSWORD'),
      sessionSecret: env('HOLTKEEPER_SESSION_SECRET'),
      secureCookies: process.env.HOLTKEEPER_INSECURE_COOKIES !== '1',
    }),
    store: multiProcess
      ? postgresStore({ url: env('HOLTKEEPER_DATABASE_URL') })
      : sqliteStore({ path: '/data/holtkeeper.db' }),
    ...(multiProcess ? {} : { databasePath: '/data/holtkeeper.db' }),
    vaultKey: env('HOLTKEEPER_VAULT_KEY'),
    hostname: '0.0.0.0',
    port,
    ...(process.env.HOLTKEEPER_PUBLIC_URL ? { publicUrl: process.env.HOLTKEEPER_PUBLIC_URL } : {}),
    artifacts: process.env.HOLTKEEPER_S3_BUCKET
      ? {
          kind: 's3',
          bucket: process.env.HOLTKEEPER_S3_BUCKET,
          accessKeyId: env('HOLTKEEPER_S3_ACCESS_KEY_ID'),
          secretAccessKey: env('HOLTKEEPER_S3_SECRET_ACCESS_KEY'),
          ...(process.env.HOLTKEEPER_S3_ENDPOINT
            ? { endpoint: process.env.HOLTKEEPER_S3_ENDPOINT }
            : {}),
          ...(process.env.HOLTKEEPER_S3_REGION ? { region: process.env.HOLTKEEPER_S3_REGION } : {}),
        }
      : { kind: 'fs', dir: '/data/artifacts' },
    retention: { days: 90 },
  },
  jobs: {
    // Each worker pod is the sandbox: jobs run in it with the repository's tool versions.
    execution: { mode: 'mise' },
    cacheDir: '/workspace/cache',
    concurrency: 2,
    schedules: [],
    webhookSecret: env('HOLTKEEPER_WEBHOOK_SECRET'),
  },
  limits: { distributed: multiProcess },
})
