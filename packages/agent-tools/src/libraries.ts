import type { Toolset } from '@holtkeeper/agent'
import { z } from 'zod'

import { type Budget, budgetOf, clip, limitLines } from './budget.ts'
import { defineTool } from './tool.ts'

/** Ecosystems the library index covers. */
export type LibraryEcosystem = 'npm' | 'Go'

/** A library as tools name it; `ecosystem` defaults to `npm`. */
export interface LibraryDocsQuery {
  package: string
  ecosystem?: LibraryEcosystem
}

/** Who asks: `repo` (`forge:path`) makes versions default to what that repository resolves. */
export interface LibraryDocsCaller {
  repo?: string
}

/**
 * Access to indexed third-party library docs, implemented elsewhere (the server passes a
 * `libraryDocs(...)` object). Every method answers with compact Markdown naming the versions it
 * comes from; unknown libraries and versions get a short explanation, never an exception.
 * `version` defaults to the caller repository's version, else the newest indexed one.
 */
export interface LibraryDocsAccess {
  versions(query: LibraryDocsQuery, caller?: LibraryDocsCaller): Promise<string>
  search(
    input: {
      package?: string
      ecosystem?: LibraryEcosystem
      version?: string
      query: string
      limit?: number
    },
    caller?: LibraryDocsCaller,
  ): Promise<string>
  read(
    input: LibraryDocsQuery & { version?: string; path?: string; heading?: string },
    caller?: LibraryDocsCaller,
  ): Promise<string>
  changes(input: LibraryDocsQuery & { from: string; to: string }): Promise<string>
  issues(
    input: LibraryDocsQuery & { query: string; version?: string; limit?: number },
    caller?: LibraryDocsCaller,
  ): Promise<string>
  source(
    input: LibraryDocsQuery & { version?: string; path?: string; start?: number; end?: number },
    caller?: LibraryDocsCaller,
  ): Promise<string>
}

export interface LibraryToolsOptions {
  access: LibraryDocsAccess
  /** The task repository as `forge:path`; versions default to what it resolves. */
  repo?: string
  budget?: Partial<Budget>
}

const ecosystem = z.enum(['npm', 'Go']).optional().describe('Default npm')
const packageName = z.string().min(1).describe('Package name, e.g. zod or github.com/spf13/cobra')
const version = z
  .string()
  .min(1)
  .optional()
  .describe('Default: the version this repository uses, else the newest indexed one')

function compact<T extends Record<string, unknown>>(input: T): T {
  const kept = { ...input }
  for (const key of Object.keys(kept)) if (kept[key] === undefined) delete kept[key]
  return kept
}

function bounded(text: string, budget: Budget): string {
  const lines = text
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => clip(line, budget.maxLineLength))
  return limitLines(lines, budget.maxResultLines, 'lines (narrow the query, path or range)').join(
    '\n',
  )
}

/**
 * The `libraries` toolset over indexed third-party docs: `libraries.versions`, `.search`, `.read`,
 * `.changes`, `.issues` and `.source`. Every call is made as the task repository, so versions
 * default to the ones it uses, and every result is cut to the toolset budget.
 */
export function libraryTools(options: LibraryToolsOptions): Toolset {
  const budget = budgetOf(options.budget)
  const { access } = options
  const caller: LibraryDocsCaller = options.repo ? { repo: options.repo } : {}
  return {
    name: 'libraries',
    tools: [
      defineTool({
        name: 'libraries.versions',
        description:
          "List the indexed versions of a third-party library with release dates, deprecations and which repositories use which version, marking this repository's. Call it first to learn what version is in use before reading docs.",
        input: z.object({ package: packageName, ecosystem }),
        async run(input) {
          return bounded(await access.versions(compact(input), caller), budget)
        },
      }),
      defineTool({
        name: 'libraries.search',
        description:
          'Search indexed docs of third-party libraries (README, guides, API docs) at the version this repository uses unless `version` is given; without `package`, over every library. Prefer it over web search or reading node_modules: answers are version-exact and short. Returns matching chunks with library, version, source and URL.',
        input: z.object({
          query: z.string().min(1),
          package: packageName.optional(),
          ecosystem,
          version,
          limit: z.number().int().min(1).max(20).optional().describe('Default 5'),
        }),
        async run(input) {
          return bounded(await access.search(compact(input), caller), budget)
        },
      }),
      defineTool({
        name: 'libraries.read',
        description:
          "Read one document of a third-party library, or one section of it by `heading`, at the version this repository uses unless `version` is given. Without `path`, lists the library's documents. Use after libraries.search to read a hit in full.",
        input: z.object({
          package: packageName,
          ecosystem,
          version,
          path: z
            .string()
            .min(1)
            .optional()
            .describe('Document path from the list or a search hit'),
          heading: z.string().min(1).optional(),
        }),
        async run(input) {
          return bounded(await access.read(compact(input), caller), budget)
        },
      }),
      defineTool({
        name: 'libraries.changes',
        description:
          'What changed in a third-party library between two versions: changelog sections and release notes in (from, to], plus migration guide sections for every crossed major. Use it when upgrading instead of searching the web for release notes.',
        input: z.object({
          package: packageName,
          ecosystem,
          from: z.string().min(1),
          to: z.string().min(1),
        }),
        async run(input) {
          return bounded(await access.changes(compact(input)), budget)
        },
      }),
      defineTool({
        name: 'libraries.issues',
        description:
          "Search a third-party library's issues and discussions for a problem, e.g. an error message after an upgrade (quote it literally). Returns digests with state, affected and fixed versions, workaround and link, then live search hits. Defaults to the version this repository uses.",
        input: z.object({
          package: packageName,
          ecosystem,
          query: z.string().min(1),
          version,
          limit: z.number().int().min(1).max(20).optional().describe('Default 5'),
        }),
        async run(input) {
          return bounded(await access.issues(compact(input), caller), budget)
        },
      }),
      defineTool({
        name: 'libraries.source',
        description:
          'Browse the source of a third-party library at the version this repository uses unless `version` is given: a file listing (under `path` when it is a directory) or numbered lines of one file. Prefer it over reading node_modules or the module cache when the docs do not answer.',
        input: z.object({
          package: packageName,
          ecosystem,
          version,
          path: z.string().min(1).optional(),
          start: z.number().int().min(1).optional().describe('First line, 1-based'),
          end: z.number().int().min(1).optional().describe('Last line, inclusive'),
        }),
        async run(input) {
          return bounded(await access.source(compact(input), caller), budget)
        },
      }),
    ],
  }
}
