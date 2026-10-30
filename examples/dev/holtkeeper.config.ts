import { noAuth } from '@holtkeeper/auth-none'
import { defineConfig } from '@holtkeeper/core'
import { sqliteStore } from '@holtkeeper/store-sqlite'
// import { postgresStore } from '@holtkeeper/store-postgres'

/** Local development: no sign-in, a SQLite file next to this config, a fixed dev vault key. */
export default defineConfig({
  forges: {
    work: {
      kind: 'gitlab',
      url: 'https://gitlab.example.com',
      create: () => {
        throw new Error('the dev config has no real forge')
      },
    },
  },
  groups: {
    games: { forge: 'work', include: ['games/*'] },
    tools: { forge: 'work', include: ['tools/*'] },
  },
  server: {
    auth: noAuth(),
    store: sqliteStore({ path: `${import.meta.dir}/holtkeeper.db` }),
    // Postgres instead (see packages/store-postgres/docs for a docker-compose service):
    // store: postgresStore({ url: { env: 'DATABASE_URL' } }),
    vaultKey: 'dev-only-vault-key-change-me-0123456789',
  },
})
