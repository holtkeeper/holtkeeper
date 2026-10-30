import type { Database } from 'bun:sqlite'

/** One schema step. Steps are append-only: never edit a released step, add a new one. */
export interface Migration {
  version: number
  sql: string
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE audit_runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        repo_forge TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        trigger TEXT NOT NULL,
        actor TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        report TEXT NOT NULL
      );
      CREATE INDEX audit_runs_finished_at ON audit_runs (finished_at DESC);
      CREATE INDEX audit_runs_repo ON audit_runs (repo_forge, repo_path, finished_at DESC);

      CREATE TABLE credentials (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        url TEXT NOT NULL,
        scope TEXT NOT NULL,
        secret TEXT NOT NULL,
        expires_at TEXT,
        rotation TEXT,
        last_rotated_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        key TEXT NOT NULL,
        scope TEXT NOT NULL,
        value TEXT NOT NULL,
        secret INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );
      CREATE INDEX settings_key ON settings (key);

      CREATE TABLE users (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        email TEXT,
        email_lower TEXT,
        grants TEXT NOT NULL,
        disabled INTEGER NOT NULL,
        session_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT
      );
      CREATE INDEX users_email_lower ON users (email_lower);

      CREATE TABLE passkeys (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT,
        label TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX passkeys_user ON passkeys (user_id);

      CREATE TABLE identities (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        email TEXT,
        PRIMARY KEY (provider, subject)
      );
      CREATE INDEX identities_user ON identities (user_id);

      CREATE TABLE link_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_by TEXT
      );
      CREATE INDEX link_tokens_user ON link_tokens (user_id);

      CREATE TABLE activity (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        subject TEXT,
        details TEXT
      );
      CREATE INDEX activity_at ON activity (at DESC);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE analyses (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        repo_forge TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT,
        created_at TEXT NOT NULL,
        actor TEXT,
        data TEXT NOT NULL
      );
      CREATE INDEX analyses_repo_kind ON analyses (repo_forge, repo_path, kind, created_at DESC);
      CREATE INDEX analyses_created_at ON analyses (created_at DESC);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        analyzer TEXT NOT NULL,
        repo_forge TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        group_name TEXT,
        ref TEXT,
        options TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        run_after TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        worker_id TEXT,
        heartbeat_at TEXT,
        error TEXT,
        analysis_id TEXT,
        log TEXT NOT NULL,
        actor TEXT
      );
      CREATE INDEX jobs_due ON jobs (status, run_after, seq);
      CREATE INDEX jobs_repo ON jobs (repo_forge, repo_path, status);
      CREATE INDEX jobs_created_at ON jobs (created_at DESC);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE knowledge (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        author TEXT NOT NULL,
        scope TEXT NOT NULL,
        topics TEXT NOT NULL,
        applies_to TEXT NOT NULL,
        packages TEXT,
        evidence TEXT NOT NULL,
        supersedes TEXT,
        tags TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT,
        version INTEGER NOT NULL
      );
      CREATE INDEX knowledge_status ON knowledge (status, updated_at DESC);
      CREATE INDEX knowledge_updated_at ON knowledge (updated_at DESC);

      CREATE TABLE knowledge_history (
        entry_id TEXT NOT NULL REFERENCES knowledge (id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        edited_by TEXT NOT NULL,
        edited_at TEXT NOT NULL,
        PRIMARY KEY (entry_id, version)
      );

      CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        title, tags, body,
        content = 'knowledge', content_rowid = 'seq',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER knowledge_fts_insert AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts (rowid, title, tags, body) VALUES (new.seq, new.title, new.tags, new.body);
      END;
      CREATE TRIGGER knowledge_fts_delete AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts (knowledge_fts, rowid, title, tags, body)
          VALUES ('delete', old.seq, old.title, old.tags, old.body);
      END;
      CREATE TRIGGER knowledge_fts_update AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts (knowledge_fts, rowid, title, tags, body)
          VALUES ('delete', old.seq, old.title, old.tags, old.body);
        INSERT INTO knowledge_fts (rowid, title, tags, body) VALUES (new.seq, new.title, new.tags, new.body);
      END;
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE credentials ADD COLUMN options TEXT;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE ai_usage (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        repo_forge TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        groups TEXT NOT NULL,
        task_kind TEXT NOT NULL,
        analyzer TEXT,
        job_id TEXT,
        analysis_id TEXT,
        actor TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        cost_source TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        turns INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX ai_usage_at ON ai_usage (at);
      CREATE INDEX ai_usage_repo_at ON ai_usage (repo_forge, repo_path, at);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE config_documents (
        type TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (type, id)
      );
      CREATE TABLE config_history (
        type TEXT NOT NULL,
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (type, id, version)
      );
      CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX kv_expires_at ON kv (expires_at) WHERE expires_at IS NOT NULL;
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE users ADD COLUMN avatar_seed TEXT;

      CREATE TABLE audit_events (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        via TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        target_repo TEXT,
        outcome TEXT NOT NULL,
        event TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE INDEX audit_events_at ON audit_events (at);
      CREATE INDEX audit_events_actor ON audit_events (actor_id, seq);
      CREATE INDEX audit_events_action ON audit_events (action, seq);
      CREATE INDEX audit_events_repo ON audit_events (target_repo, seq) WHERE target_repo IS NOT NULL;
      CREATE TABLE audit_chain (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        head_seq INTEGER NOT NULL,
        head_hash TEXT NOT NULL,
        swept_through INTEGER NOT NULL
      );

      CREATE TABLE external_accounts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        username TEXT,
        verification TEXT NOT NULL,
        linked_by TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        verified_at TEXT,
        challenge TEXT,
        principal TEXT,
        UNIQUE (provider, external_id)
      );
      CREATE INDEX external_accounts_user ON external_accounts (user_id, seq);
    `,
  },
]

/**
 * Applies every step whose version is not recorded in `schema_migrations` yet, in version order,
 * all in one transaction. Steps added out of order (a lower version merged after a higher one)
 * still run. Safe to call on every open.
 */
export function migrate(db: Database, steps: readonly Migration[] = migrations): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  )
  db.transaction(() => {
    const applied = new Set(
      db
        .query<{ version: number }, []>('SELECT version FROM schema_migrations')
        .all()
        .map((row) => row.version),
    )
    for (const step of steps.toSorted((a, b) => a.version - b.version)) {
      if (applied.has(step.version)) continue
      db.run(step.sql)
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
        step.version,
        new Date().toISOString(),
      ])
    }
  }).immediate()
}
