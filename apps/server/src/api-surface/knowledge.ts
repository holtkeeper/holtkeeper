import { type RepoTarget, type Scope, scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import {
  KnowledgeValidationError,
  citation,
  describePackage,
  proposeEntry,
  renderEntry,
  withoutSuperseded,
} from '@holtkeeper/knowledge'
import type {
  KnowledgeEntry,
  KnowledgeFilter,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgePackage,
  Store,
} from '@holtkeeper/store'

import { ToolError } from './tool-error.ts'

/** The knowledge base as the MCP tools read and propose to it, for one caller. */
export interface McpKnowledgeContext {
  store: Pick<Store, 'knowledge'> & Partial<Pick<Store, 'activity'>>
  /** Whether the caller may read entries of `scope`. */
  canReadScope: (scope: Scope) => boolean
  /** `forge:path` with its groups when the caller may read that repository's knowledge. */
  repoOf: (repo: string) => RepoTarget | undefined
  /** Who proposals are attributed to. */
  actor: string
  now: () => Date
}

/** Candidates ranked before the scope filters, so filtering does not starve `limit`. */
const pool = 500

const bodyPreview = 600

const scopeText = (scope: Scope) =>
  [
    ...(scope.all ? ['everything'] : []),
    ...(scope.groups ?? []).map(
      (group) => `group ${Array.isArray(group) ? group.join(' & ') : group}`,
    ),
    ...(scope.repos ?? []).map((repo) => `\`${repo}\``),
  ].join(', ') || 'nothing'

const preview = (body: string) => {
  const text = body.trim()
  return text.length > bodyPreview ? `${text.slice(0, bodyPreview)}…` : text
}

const readableRepo = (context: McpKnowledgeContext, repo: string) => {
  const target = context.repoOf(repo)
  if (!target)
    throw new ToolError(`You may not read the knowledge of ${repo}, or it is not a forge:path.`)
  return target
}

/** Accepted entries for a query, a repository or a package, best first. */
export async function searchKnowledge(
  context: McpKnowledgeContext,
  input: {
    query?: string | undefined
    repo?: string | undefined
    kind?: KnowledgeKind | undefined
    package?: string | undefined
    topic?: string | undefined
    limit?: number | undefined
  },
): Promise<string> {
  const filter: KnowledgeFilter = {
    status: 'accepted',
    ...(input.kind && { kind: input.kind }),
    ...(input.package && { package: input.package }),
    ...(input.topic && { topic: input.topic }),
  }
  const query = input.query?.trim()
  const hits = query
    ? await context.store.knowledge.search(query, filter, pool)
    : (await context.store.knowledge.list(filter)).map((entry) => ({ entry, score: 0 }))
  const target = input.repo ? readableRepo(context, input.repo) : undefined
  const visible = hits.filter(({ entry }) =>
    target ? scopeCoversRepo(entry.scope, target) : context.canReadScope(entry.scope),
  )
  const ranked = withoutSuperseded(visible)
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        scopeSpecificity(b.entry.scope) - scopeSpecificity(a.entry.scope) ||
        b.entry.updatedAt.localeCompare(a.entry.updatedAt),
    )
    .slice(0, input.limit ?? 10)
  if (!ranked.length)
    return `No accepted knowledge entry matches${query ? ` "${query}"` : ''}${input.repo ? ` for \`${input.repo}\`` : ''}.`
  return [
    `${ranked.length} accepted entr${ranked.length === 1 ? 'y' : 'ies'}${target ? ` applying to \`${input.repo}\`` : ''}; cite them as [kb:<id>], read one in full with get_knowledge.`,
    ...ranked.map(({ entry }) => renderEntry({ ...entry, body: preview(entry.body) })),
  ].join('\n\n')
}

const renderDetail = (entry: KnowledgeEntry) =>
  [
    `# ${citation(entry.id)} ${entry.title}`,
    [
      `- kind: ${entry.kind}, status: ${entry.status}${entry.status === 'proposed' ? ' (not reviewed yet; do not rely on it)' : ''}`,
      `- applies to: ${scopeText(entry.scope)}; tasks ${entry.appliesTo.join(', ')}`,
      ...(entry.packages?.length
        ? [`- packages: ${entry.packages.map(describePackage).join(', ')}`]
        : []),
      ...(entry.topics.length ? [`- topics: ${entry.topics.join(', ')}`] : []),
      ...(entry.supersedes ? [`- supersedes ${citation(entry.supersedes)}`] : []),
      `- ${entry.source === 'agent' ? 'proposed through an agent by' : 'written by'} ${entry.author}, updated ${entry.updatedAt.slice(0, 10)}, version ${entry.version}`,
    ].join('\n'),
    entry.body.trim(),
    ...(entry.evidence.length
      ? [`Evidence:\n${entry.evidence.map((link) => `- [${link.label}](${link.url})`).join('\n')}`]
      : []),
  ].join('\n\n')

/** One entry in full, whatever its status, when the caller may read its scope. */
export async function readKnowledge(context: McpKnowledgeContext, id: string): Promise<string> {
  const entry = await context.store.knowledge.get(id.replace(/^\[?kb:|\]$/g, ''))
  if (!entry || !context.canReadScope(entry.scope))
    throw new ToolError(`No knowledge entry ${id}; search_knowledge lists the ones you can read.`)
  return renderDetail(entry)
}

/**
 * Proposes an entry scoped to one repository the caller may read. It always waits for review,
 * and a proposal that repeats an existing entry creates nothing.
 */
export async function proposeKnowledge(
  context: McpKnowledgeContext,
  input: {
    title: string
    body: string
    repo: string
    kind?: KnowledgeKind | undefined
    topics?: string[] | undefined
    packages?: KnowledgePackage[] | undefined
    evidence?: KnowledgeLink[] | undefined
  },
): Promise<string> {
  const repo = readableRepo(context, input.repo)
  try {
    const result = await proposeEntry({
      store: context.store,
      input: {
        title: input.title,
        body: input.body,
        ...(input.kind && { kind: input.kind }),
        ...(input.topics && { topics: input.topics }),
        ...(input.packages && { packages: input.packages }),
        ...(input.evidence && { evidence: input.evidence }),
      },
      actor: context.actor,
      task: { repo },
      now: context.now,
    })
    if (result.duplicateOf)
      return `Not added: ${citation(result.duplicateOf)} (${result.entry.status}) already says this: "${result.entry.title}".${input.evidence?.length ? ' New evidence links were added to it.' : ''}`
    return `Proposed ${citation(result.entry.id)} as a ${result.entry.kind} for \`${input.repo}\`. People review it in the Knowledge page before agents use it.`
  } catch (error) {
    if (error instanceof KnowledgeValidationError)
      throw new ToolError(`Not proposed: ${error.issues.join('; ')}`)
    throw error
  }
}
