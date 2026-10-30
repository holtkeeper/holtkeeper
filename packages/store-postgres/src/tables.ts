import type { SQL } from 'bun'

/** Schema-qualified, quoted names of every table (and the search fold function) of one store. */
export interface Tables {
  auditRuns: SQL.Query<unknown>
  analyses: SQL.Query<unknown>
  credentials: SQL.Query<unknown>
  settings: SQL.Query<unknown>
  users: SQL.Query<unknown>
  passkeys: SQL.Query<unknown>
  identities: SQL.Query<unknown>
  linkTokens: SQL.Query<unknown>
  activity: SQL.Query<unknown>
  jobs: SQL.Query<unknown>
  knowledge: SQL.Query<unknown>
  knowledgeHistory: SQL.Query<unknown>
  knowledgeFold: SQL.Query<unknown>
  aiUsage: SQL.Query<unknown>
  configDocuments: SQL.Query<unknown>
  configHistory: SQL.Query<unknown>
  kv: SQL.Query<unknown>
  externalAccounts: SQL.Query<unknown>
  auditEvents: SQL.Query<unknown>
  auditState: SQL.Query<unknown>
}

/** Table names of `schema`, qualified so queries never depend on `search_path`. */
export function tables(sql: SQL, schema: string): Tables {
  const name = (table: string) => sql(`${schema}.${table}`)
  return {
    auditRuns: name('audit_runs'),
    analyses: name('analyses'),
    credentials: name('credentials'),
    settings: name('settings'),
    users: name('users'),
    passkeys: name('passkeys'),
    identities: name('identities'),
    linkTokens: name('link_tokens'),
    activity: name('activity'),
    jobs: name('jobs'),
    knowledge: name('knowledge'),
    knowledgeHistory: name('knowledge_history'),
    knowledgeFold: name('knowledge_fold'),
    aiUsage: name('ai_usage'),
    configDocuments: name('config_documents'),
    configHistory: name('config_history'),
    kv: name('kv'),
    externalAccounts: name('external_accounts'),
    auditEvents: name('audit_events'),
    auditState: name('audit_state'),
  }
}

/** A started store's client and table names, handed to every part of the store. */
export interface Db {
  sql: SQL
  t: Tables
}
