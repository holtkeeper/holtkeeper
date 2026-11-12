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
  {
    version: 7,
    sql: `
      CREATE TABLE ci_jobs (
        repo_forge text NOT NULL,
        repo_path text NOT NULL,
        job_id bigint NOT NULL,
        pipeline_id bigint NOT NULL,
        name text NOT NULL,
        stage text NOT NULL,
        status text NOT NULL,
        ref text,
        sha text,
        created_at timestamptz NOT NULL,
        started_at timestamptz,
        finished_at timestamptz,
        duration_seconds double precision,
        queued_seconds double precision,
        allow_failure boolean NOT NULL,
        web_url text NOT NULL,
        PRIMARY KEY (repo_forge, repo_path, job_id)
      );
      CREATE INDEX ci_jobs_repo_created ON ci_jobs (repo_forge, repo_path, created_at);
      CREATE INDEX ci_jobs_created ON ci_jobs (created_at);
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE jobs ADD COLUMN schedule text;
      CREATE INDEX jobs_schedule ON jobs (schedule, created_at DESC) WHERE schedule IS NOT NULL;
      ALTER TABLE ci_jobs ADD COLUMN tag boolean NOT NULL DEFAULT false;
    `,
  },
  {
    version: 9,
    sql: `
      DROP INDEX jobs_one_running_per_repo;
      CREATE UNIQUE INDEX jobs_one_running_per_analyzer ON jobs (repo_forge, repo_path, analyzer)
        WHERE status = 'running';
      CREATE INDEX jobs_active_repo ON jobs (repo_forge, repo_path, analyzer)
        WHERE status IN ('queued', 'running');
    `,
  },
  {
    version: 10,
    sql: `
      DO $migration$
      BEGIN
        EXECUTE format(
          'CREATE FUNCTION library_search_text(value text) RETURNS text
             LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
             AS $fn$ SELECT %I.knowledge_fold(regexp_replace(value, %L, %L, %L)) $fn$',
          current_schema(), '[[:punct:]]+', ' ', 'g');
      END
      $migration$;

      CREATE TABLE libraries (
        ecosystem text NOT NULL,
        name text NOT NULL,
        data jsonb NOT NULL,
        PRIMARY KEY (ecosystem, name)
      );

      CREATE TABLE library_versions (
        ecosystem text NOT NULL,
        name text NOT NULL,
        version text NOT NULL,
        data jsonb NOT NULL,
        PRIMARY KEY (ecosystem, name, version)
      );

      CREATE TABLE library_chunks (
        id text PRIMARY KEY,
        ecosystem text NOT NULL,
        name text NOT NULL,
        source text NOT NULL,
        path text NOT NULL,
        position integer NOT NULL,
        headings jsonb NOT NULL,
        heading_text text NOT NULL,
        anchor text,
        text text NOT NULL,
        url text,
        search tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('simple', library_search_text(heading_text)), 'A') ||
          setweight(to_tsvector('simple', library_search_text(text)), 'C')
        ) STORED
      );
      CREATE INDEX library_chunks_library ON library_chunks (ecosystem, name, source);
      CREATE INDEX library_chunks_path ON library_chunks (path COLLATE "C", position);
      CREATE INDEX library_chunks_search ON library_chunks USING gin (search);

      CREATE TABLE library_chunk_versions (
        chunk_id text NOT NULL REFERENCES library_chunks (id) ON DELETE CASCADE,
        version text NOT NULL,
        PRIMARY KEY (chunk_id, version)
      );
      CREATE INDEX library_chunk_versions_version ON library_chunk_versions (version, chunk_id);

      CREATE TABLE library_issues (
        id text PRIMARY KEY,
        ecosystem text NOT NULL,
        name text NOT NULL,
        state text NOT NULL,
        updated_at text NOT NULL,
        title text NOT NULL,
        digest_text text NOT NULL,
        body_text text NOT NULL,
        data jsonb NOT NULL,
        search tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('simple', library_search_text(title)), 'A') ||
          setweight(to_tsvector('simple', library_search_text(digest_text)), 'B') ||
          setweight(to_tsvector('simple', library_search_text(body_text)), 'C')
        ) STORED
      );
      CREATE INDEX library_issues_library ON library_issues (ecosystem, name);
      CREATE INDEX library_issues_search ON library_issues USING gin (search);
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE analyses ADD COLUMN sha text;
    `,
  },
  {
    version: 12,
    sql: `
      DROP TABLE activity;
    `,
  },
  {
    version: 13,
    sql: `
      ALTER TABLE jobs DROP COLUMN log;
      ALTER TABLE jobs ADD COLUMN attempts_history jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE jobs ADD COLUMN error_signature text;
      CREATE INDEX jobs_error_signature ON jobs (error_signature, created_at DESC)
        WHERE error_signature IS NOT NULL;
      CREATE INDEX jobs_failed ON jobs (finished_at DESC) WHERE status = 'failed';
    `,
  },
  {
    version: 14,
    sql: `
      CREATE TABLE guides (
        scope text NOT NULL,
        section text NOT NULL,
        data jsonb NOT NULL,
        PRIMARY KEY (scope, section)
      );
      CREATE TABLE guide_history (
        scope text NOT NULL,
        section text NOT NULL,
        version integer NOT NULL,
        data jsonb NOT NULL,
        PRIMARY KEY (scope, section, version)
      );
      CREATE TABLE families (
        id text PRIMARY KEY,
        name text NOT NULL,
        data jsonb NOT NULL
      );
    `,
  },
  {
    version: 15,
    sql: `
      CREATE TABLE learnings (
        id text PRIMARY KEY,
        repo text NOT NULL,
        key text NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX learnings_repo_key ON learnings (repo, key);
      CREATE TABLE learning_claims (
        key text PRIMARY KEY,
        at text NOT NULL
      );
      CREATE TABLE review_reactions (
        repo text NOT NULL,
        merge_request integer NOT NULL,
        note_id text NOT NULL,
        data jsonb NOT NULL,
        PRIMARY KEY (repo, merge_request, note_id)
      );
    `,
  },
  {
    version: 16,
    sql: `
      ALTER TABLE credentials ADD COLUMN capabilities jsonb;
      ALTER TABLE ai_usage ADD COLUMN transcript_ref text;
      CREATE INDEX ai_usage_job ON ai_usage (job_id);
    `,
  },
  {
    version: 17,
    sql: `
      CREATE TABLE chat_threads (
        id text PRIMARY KEY,
        updated_at text NOT NULL,
        archived boolean NOT NULL DEFAULT false,
        data jsonb NOT NULL
      );
      CREATE INDEX chat_threads_updated ON chat_threads (archived, updated_at COLLATE "C");
      CREATE TABLE chat_messages (
        seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE,
        thread_id text NOT NULL,
        author_id text,
        created_at text NOT NULL,
        updated_at text,
        data jsonb NOT NULL
      );
      CREATE INDEX chat_messages_thread ON chat_messages (thread_id, seq);
      CREATE INDEX chat_messages_changed ON chat_messages (thread_id, updated_at COLLATE "C")
        WHERE updated_at IS NOT NULL;
      CREATE TABLE chat_thread_reads (
        thread_id text NOT NULL,
        user_id text NOT NULL,
        last_read_message_id text NOT NULL,
        last_read_seq integer NOT NULL,
        PRIMARY KEY (thread_id, user_id)
      );
    `,
  },
  {
    version: 18,
    sql: `ALTER TABLE jobs ADD COLUMN reason text;`,
  },
  {
    version: 19,
    sql: `
      ALTER TABLE knowledge ADD COLUMN visibility text;
      ALTER TABLE knowledge ADD COLUMN subject text;
      CREATE INDEX knowledge_subject ON knowledge (subject) WHERE subject IS NOT NULL;
    `,
  },
  {
    version: 20,
    sql: `
      CREATE TABLE agent_task_groups (
        id text PRIMARY KEY,
        updated_at text NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX agent_task_groups_updated ON agent_task_groups (updated_at COLLATE "C");
      CREATE TABLE agent_tasks (
        id text PRIMARY KEY,
        group_id text NOT NULL,
        repo text NOT NULL,
        status text NOT NULL,
        updated_at text NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX agent_tasks_group ON agent_tasks (group_id);
      CREATE INDEX agent_tasks_repo ON agent_tasks (repo, updated_at COLLATE "C");
    `,
  },
  {
    version: 21,
    sql: `
      DELETE FROM analyses WHERE kind IN ('changelog', 'quality', 'release-risk', 'fleet', 'delivery', 'port', 'warmup');
      DELETE FROM jobs WHERE analyzer IN ('changelog', 'quality', 'release-risk', 'fleet', 'delivery', 'port', 'warmup');
      DELETE FROM settings WHERE key IN (
        'llm.model', 'llm.models', 'review.instructions', 'agent.instructions',
        'analyzers.changelog', 'analyzers.delivery', 'analyzers.fleet', 'analyzers.port',
        'analyzers.quality', 'analyzers.release-risk', 'analyzers.warmup'
      );
      DELETE FROM kv WHERE key = 'digests' OR key LIKE 'digest:%' OR key = 'chat:slack:policy';
      CREATE TEMP TABLE retired_config ON COMMIT DROP AS
        SELECT type, id, COALESCE(
          data->>'analyzer' IN ('changelog', 'quality', 'release-risk', 'fleet', 'delivery', 'port', 'warmup')
          OR (jsonb_typeof(data->'analyzers') = 'array'
            AND jsonb_array_length(data->'analyzers') > 0
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(data->'analyzers') AS kind
              WHERE kind NOT IN ('changelog', 'quality', 'release-risk', 'fleet', 'delivery', 'port', 'warmup'))), false) AS dead
        FROM config_documents
        WHERE type IN ('schedule', 'trigger') AND (
          data->>'analyzer' IN ('changelog', 'quality', 'release-risk', 'fleet', 'delivery', 'port', 'warmup')
          OR (jsonb_typeof(data->'analyzers') = 'array'
            AND data->'analyzers' ?| array['changelog', 'quality', 'release-risk', 'fleet', 'delivery', 'port', 'warmup'])
          OR (jsonb_typeof(data->'options') = 'object'
            AND data->'options' ?| array['changelog', 'quality', 'release-risk', 'fleet', 'delivery', 'port', 'warmup']));
      DELETE FROM config_history WHERE (type, id) IN (SELECT type, id FROM retired_config WHERE dead);
      DELETE FROM config_documents WHERE (type, id) IN (SELECT type, id FROM retired_config WHERE dead);
      INSERT INTO config_history (type, id, version, data, updated_at, updated_by)
        SELECT type, id, version, data, updated_at, updated_by FROM config_documents
        WHERE (type, id) IN (SELECT type, id FROM retired_config WHERE NOT dead);
      UPDATE config_documents SET
        data = (CASE WHEN jsonb_typeof(data->'analyzers') = 'array'
          THEN jsonb_set(data, '{analyzers}', COALESCE((
            SELECT jsonb_agg(kind ORDER BY ord)
            FROM jsonb_array_elements(data->'analyzers') WITH ORDINALITY AS item(kind, ord)
            WHERE kind #>> '{}' NOT IN ('changelog', 'quality', 'release-risk', 'fleet', 'delivery', 'port', 'warmup')), '[]'::jsonb))
          ELSE data END)
          #- '{options,changelog}' #- '{options,quality}' #- '{options,release-risk}' #- '{options,fleet}'
          #- '{options,delivery}' #- '{options,port}' #- '{options,warmup}',
        version = version + 1,
        updated_at = now(),
        updated_by = 'system'
        WHERE (type, id) IN (SELECT type, id FROM retired_config WHERE NOT dead);
    `,
  },
  {
    version: 22,
    sql: `ALTER TABLE analyses ADD COLUMN metrics jsonb;`,
  },
  {
    version: 23,
    sql: `
      ALTER TABLE ai_usage ADD COLUMN interactive boolean NOT NULL DEFAULT false;
      ALTER TABLE ai_usage ADD COLUMN subject text;
      CREATE INDEX ai_usage_actor_at ON ai_usage (actor, at);
      CREATE INDEX jobs_analysis ON jobs (analysis_id) WHERE analysis_id IS NOT NULL;
    `,
  },
  {
    version: 24,
    sql: `
      CREATE TABLE guide_generated (
        scope text NOT NULL,
        section text NOT NULL,
        version integer NOT NULL,
        data jsonb NOT NULL,
        PRIMARY KEY (scope, section, version)
      );
      UPDATE guides SET data = jsonb_set(data, '{generated,version}', '0')
        WHERE jsonb_typeof(data->'generated') = 'object' AND NOT (data->'generated' ? 'version');
      UPDATE guides SET data = jsonb_set(data, '{proposal,version}', '0')
        WHERE jsonb_typeof(data->'proposal') = 'object' AND NOT (data->'proposal' ? 'version');
    `,
  },
  {
    version: 25,
    sql: `
      ALTER TABLE chat_threads ADD COLUMN context_repos jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE chat_messages ADD COLUMN refs jsonb NOT NULL DEFAULT '[]'::jsonb;
      CREATE TABLE chat_thread_mutes (
        thread_id text NOT NULL,
        user_id text NOT NULL,
        PRIMARY KEY (user_id, thread_id)
      );
    `,
  },
  {
    version: 26,
    sql: `
      ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
      ALTER TABLE credentials ADD COLUMN last_used_at timestamptz;
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
