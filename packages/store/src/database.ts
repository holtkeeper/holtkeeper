/** What the store's tables hold, grouped for size reports. */
export const databaseDomains = [
  'jobs',
  'analyses',
  'audit',
  'ai',
  'knowledge',
  'libraries',
  'chat',
  'tasks',
  'config',
  'accounts',
  'other',
] as const

export type DatabaseDomain = (typeof databaseDomains)[number]

const domainOf: Record<string, DatabaseDomain> = {
  jobs: 'jobs',
  ci_jobs: 'jobs',
  analyses: 'analyses',
  audit_runs: 'analyses',
  audit_events: 'audit',
  audit_state: 'audit',
  audit_chain: 'audit',
  ai_usage: 'ai',
  knowledge: 'knowledge',
  knowledge_history: 'knowledge',
  guides: 'knowledge',
  guide_history: 'knowledge',
  families: 'knowledge',
  learnings: 'knowledge',
  learning_claims: 'knowledge',
  review_reactions: 'knowledge',
  chat_threads: 'chat',
  chat_messages: 'chat',
  chat_thread_reads: 'chat',
  agent_tasks: 'tasks',
  agent_task_groups: 'tasks',
  config_documents: 'config',
  config_history: 'config',
  settings: 'config',
  credentials: 'config',
  kv: 'config',
  users: 'accounts',
  passkeys: 'accounts',
  identities: 'accounts',
  link_tokens: 'accounts',
  external_accounts: 'accounts',
}

/**
 * The domain of a table of the SQLite or Postgres store. Search side tables (`knowledge_fts`,
 * `library_chunks_fts_data`, …) belong to the table they index; unknown tables are `other`.
 */
export function tableDomain(table: string): DatabaseDomain {
  if (table.startsWith('librar')) return 'libraries'
  if (table.startsWith('knowledge')) return 'knowledge'
  return domainOf[table] ?? 'other'
}
