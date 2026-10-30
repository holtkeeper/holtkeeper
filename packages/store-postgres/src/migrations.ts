import type { SQL } from 'bun'

/**
 * One schema step: plain DDL that runs with `search_path` set to the store's schema (then
 * `public`), so table names stay unqualified. Steps are append-only: never edit a released step,
 * add a new one.
 */
export interface Migration {
  version: number
  sql: string
}

/** Every schema step of the Postgres store, in version order. */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE audit_runs (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        repo_forge text NOT NULL,
        repo_path text NOT NULL,
        trigger text NOT NULL,
        actor text,
        started_at timestamptz NOT NULL,
        finished_at timestamptz NOT NULL,
        report jsonb NOT NULL
      );
      CREATE INDEX audit_runs_finished_at ON audit_runs (finished_at DESC, seq DESC);
      CREATE INDEX audit_runs_repo ON audit_runs (repo_forge, repo_path, finished_at DESC);

      CREATE TABLE analyses (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        repo_forge text NOT NULL,
        repo_path text NOT NULL,
        kind text NOT NULL,
        ref text,
        created_at timestamptz NOT NULL,
        actor text,
        data jsonb NOT NULL
      );
      CREATE INDEX analyses_repo_kind ON analyses (repo_forge, repo_path, kind, created_at DESC);
      CREATE INDEX analyses_created_at ON analyses (created_at DESC, seq DESC);

      CREATE TABLE credentials (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        name text NOT NULL,
        kind text NOT NULL,
        url text NOT NULL,
        scope jsonb NOT NULL,
        secret text NOT NULL,
        expires_at timestamptz,
        rotation jsonb,
        last_rotated_at timestamptz,
        last_error text,
        options jsonb,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE settings (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        key text NOT NULL,
        scope jsonb NOT NULL,
        value jsonb NOT NULL,
        secret boolean NOT NULL,
        updated_at timestamptz NOT NULL,
        updated_by text
      );
      CREATE INDEX settings_key ON settings (key);

      CREATE TABLE users (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        name text NOT NULL,
        email text,
        email_lower text,
        grants jsonb NOT NULL,
        disabled boolean NOT NULL,
        session_version integer NOT NULL,
        created_at timestamptz NOT NULL,
        created_by text
      );
      CREATE INDEX users_email_lower ON users (email_lower);

      CREATE TABLE passkeys (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        public_key text NOT NULL,
        counter bigint NOT NULL,
        transports jsonb,
        label text,
        created_at text NOT NULL,
        last_used_at text
      );
      CREATE INDEX passkeys_user ON passkeys (user_id);

      CREATE TABLE identities (
        provider text NOT NULL,
        subject text NOT NULL,
        user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        email text,
        PRIMARY KEY (provider, subject)
      );
      CREATE INDEX identities_user ON identities (user_id);

      CREATE TABLE link_tokens (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        purpose text NOT NULL,
        expires_at text NOT NULL,
        used_at text,
        created_by text
      );
      CREATE INDEX link_tokens_user ON link_tokens (user_id);

      CREATE TABLE activity (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        at timestamptz NOT NULL,
        actor text NOT NULL,
        action text NOT NULL,
        subject text,
        details jsonb
      );
      CREATE INDEX activity_at ON activity (at DESC, seq DESC);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE jobs (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        analyzer text NOT NULL,
        repo_forge text NOT NULL,
        repo_path text NOT NULL,
        group_name text,
        ref text,
        options jsonb NOT NULL,
        trigger text NOT NULL,
        status text NOT NULL,
        attempts integer NOT NULL,
        max_attempts integer NOT NULL,
        run_after timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        started_at timestamptz,
        finished_at timestamptz,
        worker_id text,
        heartbeat_at timestamptz,
        error text,
        analysis_id text,
        log jsonb NOT NULL DEFAULT '[]',
        actor text
      );
      CREATE INDEX jobs_due ON jobs (run_after, seq) WHERE status = 'queued';
      CREATE INDEX jobs_running ON jobs (heartbeat_at) WHERE status = 'running';
      CREATE UNIQUE INDEX jobs_one_running_per_repo ON jobs (repo_forge, repo_path) WHERE status = 'running';
      CREATE INDEX jobs_created_at ON jobs (created_at DESC, seq DESC);
    `,
  },
  {
    version: 3,
    sql: `
      DO $migration$
      DECLARE
        extension_schema text;
      BEGIN
        BEGIN
          CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public;
        EXCEPTION WHEN OTHERS THEN
          BEGIN
            CREATE EXTENSION IF NOT EXISTS unaccent;
          EXCEPTION WHEN OTHERS THEN
            NULL;
          END;
        END;
        SELECT n.nspname INTO extension_schema
          FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
          WHERE e.extname = 'unaccent';
        IF extension_schema IS NULL THEN
          CREATE FUNCTION knowledge_fold(value text) RETURNS text
            LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fold$ SELECT value $fold$;
        ELSE
          EXECUTE format(
            'CREATE FUNCTION knowledge_fold(value text) RETURNS text
               LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fold$ SELECT %I.unaccent(%L::regdictionary, value) $fold$',
            extension_schema, quote_ident(extension_schema) || '.unaccent');
        END IF;
      END
      $migration$;

      CREATE TABLE knowledge (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        title text NOT NULL,
        body text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        source text NOT NULL,
        author text NOT NULL,
        scope jsonb NOT NULL,
        topics jsonb NOT NULL,
        applies_to jsonb NOT NULL,
        packages jsonb,
        evidence jsonb NOT NULL,
        supersedes text,
        tags text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        updated_by text,
        version integer NOT NULL,
        search tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('simple', knowledge_fold(title)), 'A') ||
          setweight(to_tsvector('simple', knowledge_fold(tags)), 'B') ||
          setweight(to_tsvector('simple', knowledge_fold(body)), 'C')
        ) STORED
      );
      CREATE INDEX knowledge_updated_at ON knowledge (updated_at DESC, seq DESC);
      CREATE INDEX knowledge_status ON knowledge (status, updated_at DESC);
      CREATE INDEX knowledge_search ON knowledge USING gin (search);

      CREATE TABLE knowledge_history (
        entry_id text NOT NULL REFERENCES knowledge (id) ON DELETE CASCADE,
        version integer NOT NULL,
        content jsonb NOT NULL,
        edited_by text NOT NULL,
        edited_at timestamptz NOT NULL,
        PRIMARY KEY (entry_id, version)
      );
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE ai_usage (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        at timestamptz NOT NULL,
        repo_forge text NOT NULL,
        repo_path text NOT NULL,
        groups jsonb NOT NULL,
        task_kind text NOT NULL,
        analyzer text,
        job_id text,
        analysis_id text,
        actor text NOT NULL,
        provider text NOT NULL,
        model text NOT NULL,
        input_tokens bigint NOT NULL,
        output_tokens bigint NOT NULL,
        cache_read_tokens bigint NOT NULL,
        cache_write_tokens bigint NOT NULL,
        cost_usd double precision NOT NULL,
        cost_source text NOT NULL,
        duration_ms bigint NOT NULL,
        turns integer NOT NULL,
        outcome text NOT NULL,
        error text
      );
      CREATE INDEX ai_usage_at ON ai_usage (at DESC, seq DESC);
      CREATE INDEX ai_usage_repo_at ON ai_usage (repo_forge, repo_path, at);
      CREATE INDEX ai_usage_groups ON ai_usage USING gin (groups jsonb_path_ops);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE config_documents (
        type text NOT NULL,
        id text NOT NULL,
        data jsonb NOT NULL,
        version integer NOT NULL,
        updated_at timestamptz NOT NULL,
        updated_by text,
        PRIMARY KEY (type, id)
      );
      CREATE TABLE config_history (
        type text NOT NULL,
        id text NOT NULL,
        version integer NOT NULL,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL,
        updated_by text,
        PRIMARY KEY (type, id, version)
      );
      CREATE TABLE kv (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        expires_at timestamptz
      );
      CREATE INDEX kv_expires_at ON kv (expires_at) WHERE expires_at IS NOT NULL;
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE users ADD COLUMN avatar_seed text;

      CREATE TABLE external_accounts (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        user_id text NOT NULL,
        provider text NOT NULL,
        external_id text NOT NULL,
        username text,
        verification text NOT NULL,
        linked_by text NOT NULL,
        linked_at timestamptz NOT NULL,
        verified_at timestamptz,
        challenge jsonb,
        principal jsonb,
        CONSTRAINT external_accounts_provider_external_id UNIQUE (provider, external_id)
      );
      CREATE INDEX external_accounts_user ON external_accounts (user_id, seq);

      CREATE TABLE audit_events (
        seq bigint PRIMARY KEY,
        id text NOT NULL UNIQUE,
        at timestamptz NOT NULL,
        actor_id text NOT NULL,
        action text NOT NULL,
        target_type text NOT NULL,
        target_id text,
        target_repo text,
        outcome text NOT NULL,
        via text NOT NULL,
        event jsonb NOT NULL
      );
      CREATE INDEX audit_events_at ON audit_events (at);
      CREATE INDEX audit_events_actor ON audit_events (actor_id, seq DESC);
      CREATE INDEX audit_events_action ON audit_events (action text_pattern_ops, seq DESC);
      CREATE INDEX audit_events_target ON audit_events (target_type, target_id, seq DESC);
      CREATE INDEX audit_events_repo ON audit_events (target_repo, seq DESC) WHERE target_repo IS NOT NULL;

      CREATE TABLE audit_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        head_seq bigint NOT NULL,
        head_hash text,
        swept_through bigint NOT NULL
      );
      INSERT INTO audit_state (head_seq, head_hash, swept_through) VALUES (0, NULL, 0);
    `,
  },
]

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/

/** Returns `schema` when it is a plain lowercase Postgres identifier; throws otherwise. */
export function checkSchemaName(schema: string): string {
  if (!SCHEMA_NAME.test(schema))
    throw new Error(`invalid Postgres schema name ${JSON.stringify(schema)}: use [a-z_][a-z0-9_]*`)
  return schema
}

/** The key `pg_advisory_xact_lock` takes while migrating one schema. */
export const migrationLockKey = (schema: string) => `holtkeeper.migrate:${schema}`

/** The steps of `steps` whose version is not in `applied`, in version order. */
export function pendingMigrations(
  steps: readonly Migration[],
  applied: Iterable<number>,
): Migration[] {
  const done = new Set(applied)
  return steps.filter((step) => !done.has(step.version)).toSorted((a, b) => a.version - b.version)
}

/**
 * Creates `schema` if it does not exist (a schema created beforehand needs no `CREATE` right on
 * the database) and applies every step whose version is not recorded in its
 * `schema_migrations` table, all in one transaction that holds a transaction-level advisory lock
 * for the schema. Processes that start together serialize on the lock; the later ones find
 * nothing to do. A failing step rolls everything back. Safe to call on every start.
 */
export async function migrate(
  sql: SQL,
  schema: string,
  steps: readonly Migration[] = migrations,
): Promise<number[]> {
  checkSchemaName(schema)
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${migrationLockKey(schema)}, 0))`
    const [existing] = await tx`SELECT 1 FROM pg_namespace WHERE nspname = ${schema}`
    if (!existing) await tx`CREATE SCHEMA ${tx(schema)}`
    await tx`SET LOCAL search_path TO ${tx(schema)}, public`
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`
    const rows: { version: number }[] = await tx`SELECT version FROM schema_migrations`
    const pending = pendingMigrations(
      steps,
      rows.map((row) => row.version),
    )
    for (const step of pending) {
      // oxlint-disable-next-line no-await-in-loop -- steps build on each other and run in order
      await tx.unsafe(step.sql)
      // oxlint-disable-next-line no-await-in-loop -- see above
      await tx`INSERT INTO schema_migrations (version) VALUES (${step.version})`
    }
    return pending.map((step) => step.version)
  })
}
