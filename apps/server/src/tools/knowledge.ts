import { type RepoTarget, type Scope, scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import { type RegistryToolset, ToolError, defineTool } from '@holtkeeper/agent-tools'
import {
  KnowledgeValidationError,
  citation,
  describePackage,
  knowledgeKinds,
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
import { webPaths } from '@holtkeeper/web-paths'
import { z } from 'zod'

import { ForbiddenToolError } from '../context.ts'

/** The knowledge base as the knowledge tools read and propose to it, for one caller. */
export interface KnowledgeToolsContext {
  store: Pick<Store, 'knowledge'> & Partial<Pick<Store, 'audit'>>
  /** Whether the caller may read entries of `scope`. */
  canReadScope: (scope: Scope) => boolean
  /** Whether the caller may read accepted `shared` entries of `scope` (cross-team reach); default never. */
  canReadShared?: (scope: Scope) => boolean
  /** The teams an entry of `scope` belongs to (innermost config groups), named on shared entries of other teams. */
  ownerOf?: (scope: Scope) => string[]
  /** `forge:path` with its groups when the caller may read that repository's knowledge. */
  repoOf: (repo: string) => RepoTarget | undefined
  /** How a group key is named in tool output; default the key itself. */
  groupLabel?: (key: string) => string
  /** Who proposals are attributed to. */
  actor: string
  now: () => Date
}

/** Candidates ranked before the scope filters, so filtering does not starve `limit`. */
const pool = 500

const bodyPreview = 600

const scopeText = (scope: Scope, label: (key: string) => string) =>
  [
    ...(scope.all ? ['everything'] : []),
    ...(scope.groups ?? []).map(
      (group) => `group ${Array.isArray(group) ? group.map(label).join(' & ') : label(group)}`,
    ),
    ...(scope.repos ?? []).map((repo) => `\`${repo}\``),
  ].join(', ') || 'nothing'

const preview = (body: string) => {
  const text = body.trim()
  return text.length > bodyPreview ? `${text.slice(0, bodyPreview)}…` : text
}

/** Whether the caller may read `entry`: its scope, or an accepted `shared` entry within reach. */
const canReadEntry = (context: KnowledgeToolsContext, entry: KnowledgeEntry): boolean =>
  context.canReadScope(entry.scope) ||
  (entry.visibility === 'shared' &&
    entry.status === 'accepted' &&
    context.canReadShared?.(entry.scope) === true)

const renderHit = (context: KnowledgeToolsContext, entry: KnowledgeEntry) => {
  const text = renderEntry({ ...entry, body: preview(entry.body) })
  if (context.canReadScope(entry.scope)) return text
  const owner = context.ownerOf?.(entry.scope) ?? []
  return `${text}_shared by ${owner.length ? `team ${owner.join(', ')}` : 'another team'}_\n`
}

const readableRepo = (context: KnowledgeToolsContext, repo: string) => {
  const target = context.repoOf(repo)
  if (!target)
    throw new ForbiddenToolError(
      `You may not read the knowledge of ${repo}, or it is not a forge:path.`,
      'knowledge:read',
      repo,
    )
  return target
}

/** Accepted entries for a query, a repository or a package, best first. */
export async function searchKnowledge(
  context: KnowledgeToolsContext,
  input: {
    query?: string | undefined
    repo?: string | undefined
    kind?: KnowledgeKind | undefined
    package?: string | undefined
    subject?: string | undefined
    topic?: string | undefined
    limit?: number | undefined
  },
): Promise<string> {
  const filter: KnowledgeFilter = {
    status: 'accepted',
    ...(input.kind && { kind: input.kind }),
    ...(input.package && { package: input.package }),
    ...(input.subject && { subject: input.subject }),
    ...(input.topic && { topic: input.topic }),
  }
  const query = input.query?.trim()
  const hits = query
    ? await context.store.knowledge.search(query, filter, pool)
    : (await context.store.knowledge.list(filter)).map((entry) => ({ entry, score: 0 }))
  const target = input.repo ? readableRepo(context, input.repo) : undefined
  const about = input.package !== undefined || input.subject !== undefined
  const visible = hits.filter(({ entry }) =>
    target
      ? scopeCoversRepo(entry.scope, target) || (about && canReadEntry(context, entry))
      : canReadEntry(context, entry),
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
    ...ranked.map(({ entry }) => renderHit(context, entry)),
  ].join('\n\n')
}

const renderDetail = (entry: KnowledgeEntry, label: (key: string) => string) =>
  [
    `# ${citation(entry.id)} ${entry.title}`,
    [
      `- kind: ${entry.kind}, status: ${entry.status}${entry.status === 'proposed' ? ' (not reviewed yet; do not rely on it)' : ''}`,
      `- applies to: ${scopeText(entry.scope, label)}; tasks ${entry.appliesTo.join(', ')}`,
      ...(entry.packages?.length
        ? [`- packages: ${entry.packages.map(describePackage).join(', ')}`]
        : []),
      ...(entry.subject ? [`- subject: ${entry.subject}`] : []),
      `- visibility: ${entry.visibility ?? 'team'}`,
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
async function readKnowledge(context: KnowledgeToolsContext, id: string): Promise<string> {
  const entry = await context.store.knowledge.get(id.replace(/^\[?kb:|\]$/g, ''))
  if (!entry || !canReadEntry(context, entry))
    throw new ToolError(`No knowledge entry ${id}; search_knowledge lists the ones you can read.`)
  return renderDetail(entry, context.groupLabel ?? ((key) => key))
}

/**
 * Proposes an entry scoped to one repository the caller may read. It always waits for review,
 * and a proposal that repeats an existing entry creates nothing.
 */
async function proposeKnowledge(
  context: KnowledgeToolsContext,
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
    return `Proposed ${citation(result.entry.id)} as a ${result.entry.kind} for \`${input.repo}\`. People review it in Knowledge › Notes (${webPaths.knowledge('notes')}) before agents use it.`
  } catch (error) {
    if (error instanceof KnowledgeValidationError)
      throw new ToolError(`Not proposed: ${error.issues.join('; ')}`)
    throw error
  }
}

const kindArg = z.enum(knowledgeKinds)

/**
 * The `knowledge` toolset of the MCP endpoint: `search_knowledge`, `get_knowledge` and
 * `propose_knowledge`, limited to what `context` lets the caller read.
 */
export function knowledgeToolset(context: KnowledgeToolsContext): RegistryToolset {
  return {
    name: 'knowledge',
    instructions: [
      'The team knowledge base holds decisions, conventions, migration notes and quirks:',
      'search_knowledge before solving a problem the team may have solved, cite entries as [kb:<id>],',
      'and propose_knowledge for a reusable lesson (people review proposals before agents rely on them).',
    ].join(' '),
    tools: [
      defineTool({
        name: 'search_knowledge',
        description:
          "Searches the accepted entries of the team knowledge base — decisions, conventions, migration notes, quirks and how-tos — best match first, bodies trimmed. Other teams' entries marked shared are included and name the team. With `repo`, only entries that apply to that repository (plus shared entries when you filter by `package` or `subject`). Without `query`, lists every applicable entry, most specific first.",
        input: z.object({
          query: z
            .string()
            .optional()
            .describe('Words to match, e.g. an API name or error message'),
          repo: z.string().optional().describe('The repository you work in, as forge:path'),
          kind: kindArg.optional(),
          package: z.string().optional().describe('Only entries about this package, e.g. react'),
          subject: z
            .string()
            .optional()
            .describe('Only entries with this subject, e.g. npm:react or tool:node'),
          topic: z.string().optional().describe('Only entries with this topic, e.g. testing'),
          limit: z.number().int().min(1).max(30).optional().describe('Default 10'),
        }),
        defaultLimit: 10,
        run: (input) => searchKnowledge(context, input),
        subject: (input) => input.package ?? input.subject ?? input.repo ?? input.query,
      }),
      defineTool({
        name: 'get_knowledge',
        description:
          'One knowledge base entry in full: body, status, scope, packages, topics, evidence links and the entry it supersedes.',
        input: z.object({ id: z.string().min(1).describe('Entry id, or its citation [kb:<id>]') }),
        run: ({ id }) => readKnowledge(context, id),
        subject: ({ id }) => id,
      }),
      defineTool({
        name: 'propose_knowledge',
        description:
          'Proposes a knowledge base entry for one repository: a short, reusable lesson other people and agents should know (a convention, a pitfall, an upgrade step). It is attributed to you and waits for review; a proposal that repeats an existing entry is not added. Search first.',
        input: z.object({
          title: z.string().min(1).max(200).describe('One-sentence statement'),
          body: z.string().min(1).max(8000).describe('Markdown explanation with an example'),
          repo: z.string().min(1).describe('The repository it applies to, as forge:path'),
          kind: kindArg.optional().describe('Default: classified from the text'),
          topics: z.array(z.string().min(1)).max(10).optional(),
          packages: z
            .array(
              z.object({
                ecosystem: z.string().min(1).describe('npm or go'),
                name: z.string().min(1),
                from: z.string().optional().describe('Semver range the note starts from'),
                to: z.string().optional().describe('Semver range the note lands on'),
              }),
            )
            .max(10)
            .optional(),
          evidence: z
            .array(z.object({ label: z.string().min(1), url: z.url() }))
            .max(10)
            .optional()
            .describe('Links backing it up: merge requests, issues, docs'),
        }),
        readOnly: false,
        run: (input) => proposeKnowledge(context, input),
        subject: ({ repo }) => repo,
      }),
    ],
  }
}
