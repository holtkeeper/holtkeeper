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
  jobs: SQL.Query<unknown>
  knowledge: SQL.Query<unknown>
  knowledgeHistory: SQL.Query<unknown>
  knowledgeFold: SQL.Query<unknown>
  guides: SQL.Query<unknown>
  guideHistory: SQL.Query<unknown>
  guideGenerated: SQL.Query<unknown>
  families: SQL.Query<unknown>
  learnings: SQL.Query<unknown>
  learningClaims: SQL.Query<unknown>
  reviewReactions: SQL.Query<unknown>
  aiUsage: SQL.Query<unknown>
  ciJobs: SQL.Query<unknown>
  chatThreads: SQL.Query<unknown>
  chatMessages: SQL.Query<unknown>
  chatThreadReads: SQL.Query<unknown>
  chatThreadMutes: SQL.Query<unknown>
  agentTasks: SQL.Query<unknown>
  agentTaskGroups: SQL.Query<unknown>
  configDocuments: SQL.Query<unknown>
  configHistory: SQL.Query<unknown>
  kv: SQL.Query<unknown>
  externalAccounts: SQL.Query<unknown>
  auditEvents: SQL.Query<unknown>
  auditState: SQL.Query<unknown>
  libraries: SQL.Query<unknown>
  libraryVersions: SQL.Query<unknown>
  libraryChunks: SQL.Query<unknown>
  libraryChunkVersions: SQL.Query<unknown>
  libraryIssues: SQL.Query<unknown>
  slackMessages: SQL.Query<unknown>
  slackReplies: SQL.Query<unknown>
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
    jobs: name('jobs'),
    knowledge: name('knowledge'),
    knowledgeHistory: name('knowledge_history'),
    knowledgeFold: name('knowledge_fold'),
    guides: name('guides'),
    guideHistory: name('guide_history'),
    guideGenerated: name('guide_generated'),
    families: name('families'),
    learnings: name('learnings'),
    learningClaims: name('learning_claims'),
    reviewReactions: name('review_reactions'),
    aiUsage: name('ai_usage'),
    ciJobs: name('ci_jobs'),
    chatThreads: name('chat_threads'),
    chatMessages: name('chat_messages'),
    chatThreadReads: name('chat_thread_reads'),
    chatThreadMutes: name('chat_thread_mutes'),
    agentTasks: name('agent_tasks'),
    agentTaskGroups: name('agent_task_groups'),
    configDocuments: name('config_documents'),
    configHistory: name('config_history'),
    kv: name('kv'),
    externalAccounts: name('external_accounts'),
    auditEvents: name('audit_events'),
    auditState: name('audit_state'),
    libraries: name('libraries'),
    libraryVersions: name('library_versions'),
    libraryChunks: name('library_chunks'),
    libraryChunkVersions: name('library_chunk_versions'),
    libraryIssues: name('library_issues'),
    slackMessages: name('slack_messages'),
    slackReplies: name('slack_replies'),
  }
}

/** A started store's client and table names, handed to every part of the store. */
export interface Db {
  sql: SQL
  t: Tables
}
