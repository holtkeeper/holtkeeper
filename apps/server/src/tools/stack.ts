import { type RegistryToolset, ToolError, defineTool } from '@holtkeeper/agent-tools'
import type { StackGroupView, StackUse } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { z } from 'zod'

import { repoKey } from '../context.ts'

/** What the `stack` tools read, limited to what one caller may see. */
export interface StackToolsContext {
  /** The newest stack view of every group, already limited to the caller's catalog reach. */
  views: () => Promise<StackGroupView[]>
  /** The teams (config groups) of a repository, named on every row. */
  ownerOf: (repo: RepoRef) => string[]
  /** Direct dependencies of a repository at their resolved versions, for `repo_stack`. */
  dependencies?: (repo: RepoRef) => Promise<{ ecosystem: string; name: string; version: string }[]>
}

/** One use of a tool by one repository, with the tool and the repository's forge. */
export interface StackUseRow {
  forge: string
  toolId: string
  toolName: string
  latest?: string
  use: StackUse
}

const MAX_ROWS = 40
const MAX_DEPENDENCIES = 25

const supportLabel: Record<StackUse['support'], string> = {
  active: 'supported',
  lts: 'supported (LTS)',
  'eol-soon': 'end of life soon',
  eol: 'end of life',
  unknown: 'support unknown',
}

/** Every use of every tool across the views, one per repository, tool and file. */
export function stackUseRows(views: readonly StackGroupView[]): StackUseRow[] {
  const rows = new Map<string, StackUseRow>()
  for (const view of views)
    for (const tool of view.tools)
      for (const use of tool.uses) {
        const key = `${view.forge}:${use.repo}\0${tool.id}\0${use.file}`
        if (!rows.has(key))
          rows.set(key, {
            forge: view.forge,
            toolId: tool.id,
            toolName: tool.name,
            ...(tool.latest ? { latest: tool.latest } : {}),
            use,
          })
      }
  return [...rows.values()]
}

/** Whether a tool id or name matches what the caller typed: exact, or the part after `image:`. */
export const matchesTool = (row: Pick<StackUseRow, 'toolId' | 'toolName'>, query: string) => {
  const wanted = query.trim().toLowerCase()
  const id = row.toolId.toLowerCase()
  return id === wanted || row.toolName.toLowerCase() === wanted || id === `image:${wanted}`
}

const versionOf = (use: StackUse) => use.version ?? use.declared

const matchesVersion = (use: StackUse, version: string) => {
  const wanted = version.trim().replace(/^v/, '')
  const actual = versionOf(use).replace(/^v/, '')
  return actual === wanted || actual.startsWith(`${wanted}.`) || use.cycle === wanted
}

const ownerText = (owner: readonly string[]) => (owner.length ? owner.join(', ') : 'no team')

/**
 * Markdown of the repositories using a stack tool (runtime, package manager, base image, chart),
 * optionally narrowed to one version or release line, grouped by team with support status. At
 * most `MAX_ROWS` rows are listed; the rest are counted.
 */
export function renderStackUsage(
  rows: readonly StackUseRow[],
  ownerOf: (repo: RepoRef) => string[],
  query: { tool: string; version?: string | undefined },
): string {
  const matching = rows.filter(
    (row) =>
      matchesTool(row, query.tool) && (!query.version || matchesVersion(row.use, query.version)),
  )
  if (!matching.length) {
    const known = [...new Set(rows.map((row) => row.toolId))].toSorted().slice(0, 30)
    return `No repository you can see uses ${query.tool}${query.version ? ` ${query.version}` : ''}.${known.length ? ` Known tools: ${known.join(', ')}.` : ''}`
  }
  const latest = matching.find((row) => row.latest)?.latest
  const versions = new Map<string, number>()
  for (const row of matching) {
    const line = row.use.cycle ?? versionOf(row.use)
    versions.set(line, (versions.get(line) ?? 0) + 1)
  }
  const byTeam = new Map<string, StackUseRow[]>()
  for (const row of matching) {
    const owner = ownerText(ownerOf({ forge: row.forge, path: row.use.repo }))
    byTeam.set(owner, [...(byTeam.get(owner) ?? []), row])
  }
  const lines = [
    `# ${matching[0]?.toolName ?? query.tool}${query.version ? ` ${query.version}` : ''}: ${matching.length} use${matching.length === 1 ? '' : 's'}${latest ? `, latest ${latest}` : ''}`,
    `Versions: ${[...versions]
      .toSorted((a, b) => b[1] - a[1])
      .map(([version, count]) => `${version} (${count})`)
      .join(', ')}`,
  ]
  let listed = 0
  for (const [owner, teamRows] of [...byTeam].toSorted(([a], [b]) => a.localeCompare(b))) {
    lines.push('', `## team ${owner}`)
    for (const row of teamRows.toSorted((a, b) => a.use.repo.localeCompare(b.use.repo))) {
      if (listed >= MAX_ROWS) break
      listed += 1
      lines.push(
        `- \`${row.forge}:${row.use.repo}\` ${row.use.declared} in \`${row.use.file}\` (${row.use.via}), ${supportLabel[row.use.support]}${row.use.eolDate ? ` (${row.use.eolDate})` : ''}`,
      )
    }
  }
  if (matching.length > listed)
    lines.push('', `…and ${matching.length - listed} more uses; pass \`version\` to narrow.`)
  return lines.join('\n')
}

/** Markdown of one repository's runtimes, images, conventions status and key dependencies. */
function renderRepoStack(
  repo: string,
  views: readonly StackGroupView[],
  owner: readonly string[],
  dependencies: readonly { ecosystem: string; name: string; version: string }[] | undefined,
): string | undefined {
  const separator = repo.indexOf(':')
  const forge = repo.slice(0, separator)
  const path = repo.slice(separator + 1)
  const mine = views.filter(
    (view) => view.forge === forge && view.repos.some((item) => item.path === path),
  )
  if (!mine.length && !dependencies?.length) return undefined
  const rows = stackUseRows(mine).filter((row) => row.use.repo === path)
  const conventions = new Map<string, StackGroupView['conventions'][number]>()
  for (const view of mine)
    for (const result of view.conventions)
      if (result.repo === path && !conventions.has(result.file))
        conventions.set(result.file, result)
  const checked = mine
    .map((view) => view.checkedAt)
    .toSorted()
    .at(-1)
  const lines = [
    `# \`${repo}\` (team ${ownerText(owner)})${checked ? `, stack checked ${checked.slice(0, 10)}` : ''}`,
  ]
  if (rows.length) {
    lines.push('', '## Runtimes, tools and images')
    for (const row of rows.toSorted((a, b) => a.toolName.localeCompare(b.toolName)))
      lines.push(
        `- ${row.toolName} ${row.use.declared}${row.latest ? ` (latest ${row.latest})` : ''} in \`${row.use.file}\`, ${supportLabel[row.use.support]}${row.use.eolDate ? ` (${row.use.eolDate})` : ''}`,
      )
  }
  if (conventions.size) {
    lines.push('', '## Conventions')
    for (const result of conventions.values())
      lines.push(
        `- \`${result.file}\`: ${result.status}${result.problems.length ? ` — ${result.problems.slice(0, 3).join('; ')}` : ''}`,
      )
  }
  if (dependencies?.length) {
    lines.push('', '## Key dependencies')
    for (const dep of dependencies.slice(0, MAX_DEPENDENCIES))
      lines.push(`- ${dep.name} ${dep.version} (${dep.ecosystem})`)
    if (dependencies.length > MAX_DEPENDENCIES)
      lines.push(
        `…and ${dependencies.length - MAX_DEPENDENCIES} more; repo_packages lists what the code imports.`,
      )
  }
  return lines.join('\n')
}

const parseRepo = (value: string): RepoRef | undefined => {
  const separator = value.indexOf(':')
  if (separator < 1 || separator === value.length - 1) return undefined
  return { forge: value.slice(0, separator), path: value.slice(separator + 1) }
}

/**
 * The `stack` toolset over the newest stack records: `stack_usage` (which repositories use a
 * runtime, image or tool, at which versions, with end-of-life status) and `repo_stack` (one
 * repository's runtimes, images, conventions status and key dependencies). Read-only, deterministic,
 * limited to what `context` lets the caller see; every row names its team.
 */
export function stackToolset(context: StackToolsContext): RegistryToolset {
  return {
    name: 'stack',
    instructions: [
      'Holtkeeper records which runtimes, package managers, base images and charts every repository',
      'uses: stack_usage shows who uses a tool at which version with end-of-life status (copy what',
      'the organization already uses when writing a Dockerfile or CI config); repo_stack shows one',
      'repository’s stack, conventions status and key dependencies.',
    ].join(' '),
    tools: [
      defineTool({
        name: 'stack_usage',
        description:
          'Which repositories use a runtime, package manager, base image or chart (node, go, pnpm, postgres, an image name), at which versions and release lines, grouped by team with end-of-life status. Narrow with `version` (a version or release line such as 20).',
        input: z.object({
          tool: z.string().min(1).describe('Tool id or name: node, go, pnpm, an image name'),
          version: z.string().min(1).optional().describe('Version or release line, e.g. 20'),
        }),
        run: async ({ tool, version }) =>
          renderStackUsage(stackUseRows(await context.views()), context.ownerOf, {
            tool,
            version,
          }),
        subject: ({ tool }) => tool,
      }),
      defineTool({
        name: 'repo_stack',
        description:
          'One repository’s runtimes, tools and images with support status, its conventions status (matches, drifts, missing) and its key direct dependencies.',
        input: z.object({ repo: z.string().min(1).describe('Repository as forge:path') }),
        run: async ({ repo }) => {
          const ref = parseRepo(repo)
          if (!ref) throw new ToolError(`${repo} is not a forge:path.`)
          const [views, dependencies] = await Promise.all([
            context.views(),
            context.dependencies?.(ref),
          ])
          const text = renderRepoStack(repoKey(ref), views, context.ownerOf(ref), dependencies)
          if (!text)
            throw new ToolError(
              `No stack record or dependency inventory of ${repo} you can see; check the forge:path.`,
            )
          return text
        },
        subject: ({ repo }) => repo,
      }),
    ],
  }
}
