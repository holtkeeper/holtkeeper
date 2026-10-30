import type { RepoRef } from '@holtkeeper/forge'
import { z } from 'zod'

import { extract, extractorSchema } from '../extractors/index.ts'
import { globToRegExp, isGlob, literalPrefix } from '../glob.ts'
import type { SourceRead, TrackerError } from '../types.ts'
import {
  errorMessage,
  mapLimit,
  type SourceContext,
  type SourceHit,
  type SourceProvider,
  type SourceResult,
  type TrackerForge,
} from './types.ts'

const schema = z.object({
  kind: z.literal('files'),
  id: z.string().min(1).optional(),
  role: z.string().min(1).meta({ 'x-role': 'provides' }),
  /** Repository paths or globs; literal paths are read even outside the analyzed group. */
  repos: z.array(z.string().min(1)).optional(),
  /** Config groups whose repositories are read. */
  groups: z.array(z.string().min(1)).optional(),
  /** File paths or globs inside each repository. */
  paths: z.array(z.string().min(1)).min(1),
  /** Globs of files to leave out. */
  exclude: z.array(z.string().min(1)).optional(),
  /** Branch, tag or commit; the default branch when omitted. */
  ref: z.string().min(1).optional(),
  extract: extractorSchema,
  /** A fixed environment, or a regular expression on the file path whose group `env` (or group 1) names it. */
  environment: z.union([z.string().min(1), z.object({ fromPath: z.string().min(1) })]).optional(),
  /** Files read per repository at most. */
  maxFiles: z.number().int().positive().default(200),
  /** Bytes read per repository at most. */
  maxBytes: z.number().int().positive().default(5_000_000),
  /** Larger files are skipped. */
  maxFileBytes: z.number().int().positive().default(1_000_000),
})

/** A `files` source as configured. */
export type FilesSourceConfig = z.output<typeof schema>

const stripForge = (pattern: string) => {
  const colon = pattern.indexOf(':')
  return colon > 0 && !pattern.slice(0, colon).includes('/') ? pattern.slice(colon + 1) : pattern
}

/** Repositories a `files` source reads, in a stable order; unknown groups become errors. */
export function selectRepos(
  config: Pick<FilesSourceConfig, 'repos' | 'groups'>,
  context: Pick<SourceContext, 'repos' | 'group' | 'groupRepos' | 'id'>,
  errors: TrackerError[],
): RepoRef[] {
  const forge = context.repos[0]?.forge ?? ''
  let pool = context.repos
  if (config.groups?.length) {
    pool = config.groups.flatMap((group) => {
      const repos =
        context.groupRepos?.(group) ?? (group === context.group ? context.repos : undefined)
      if (!repos) errors.push({ source: context.id, message: `group ${group} is unknown` })
      return repos ?? []
    })
  }
  const chosen = new Map<string, RepoRef>()
  if (!config.repos?.length) for (const repo of pool) chosen.set(repo.path, repo)
  for (const raw of config.repos ?? []) {
    const pattern = stripForge(raw)
    if (isGlob(pattern)) {
      const regexp = globToRegExp(pattern)
      for (const repo of pool) if (regexp.test(repo.path)) chosen.set(repo.path, repo)
    } else
      chosen.set(pattern, pool.find((repo) => repo.path === pattern) ?? { forge, path: pattern })
  }
  return [...chosen.values()].toSorted((a, b) => a.path.localeCompare(b.path))
}

/** Files of `repo` matching the source's paths, listing each glob's literal directory once. */
async function filesOf(
  forge: TrackerForge,
  repo: string,
  config: FilesSourceConfig,
): Promise<string[]> {
  const files = new Set<string>()
  const listings = new Map<string, Promise<string[]>>()
  const exclude = (config.exclude ?? []).map(globToRegExp)
  for (const path of config.paths) {
    if (!isGlob(path)) {
      files.add(path)
      continue
    }
    if (!forge.listFiles)
      throw new Error(`the forge cannot list files, so glob ${path} cannot be expanded`)
    const list = forge.listFiles.bind(forge)
    const base = literalPrefix(path)
    let listing = listings.get(base)
    if (!listing) {
      listing = list(repo, {
        ...(base ? { path: base } : {}),
        ...(config.ref ? { ref: config.ref } : {}),
        recursive: true,
        limit: 10_000,
      }).then((entries) =>
        entries.filter((entry) => entry.type === 'file').map((entry) => entry.path),
      )
      listings.set(base, listing)
    }
    const regexp = globToRegExp(path)
    for (const file of await listing) if (regexp.test(file)) files.add(file)
  }
  return [...files].filter((file) => !exclude.some((regexp) => regexp.test(file))).toSorted()
}

/** The environment of a file: fixed, or captured from its path. */
export function environmentOf(
  environment: FilesSourceConfig['environment'],
  file: string,
): string | undefined {
  if (environment === undefined) return undefined
  if (typeof environment === 'string') return environment
  const match = new RegExp(environment.fromPath).exec(file)
  return match ? (match.groups?.env ?? match[1]) || undefined : undefined
}

async function readRepo(
  forge: TrackerForge,
  repo: RepoRef,
  config: FilesSourceConfig,
  context: SourceContext,
): Promise<{ hits: SourceHit[]; read: SourceRead; errors: TrackerError[] }> {
  const read: SourceRead = {
    source: context.id,
    kind: 'files',
    role: config.role,
    repo: repo.path,
    files: 0,
    bytes: 0,
    extracted: 0,
  }
  const errors: TrackerError[] = []
  const hits: SourceHit[] = []
  let files: string[]
  try {
    files = await filesOf(forge, repo.path, config)
  } catch (error) {
    errors.push({ source: context.id, repo: repo.path, message: errorMessage(error) })
    return { hits, read, errors }
  }
  if (files.length > config.maxFiles) {
    read.skipped = files.length - config.maxFiles
    errors.push({
      source: context.id,
      repo: repo.path,
      message: `${files.length} files match, only the first ${config.maxFiles} are read (maxFiles)`,
    })
    files = files.slice(0, config.maxFiles)
  }
  const contents = await mapLimit(files, context.concurrency, async (file) => {
    try {
      return { file, text: await forge.readFile(repo.path, file, config.ref) }
    } catch (error) {
      errors.push({ source: context.id, repo: repo.path, file, message: errorMessage(error) })
      return { file, text: undefined }
    }
  })
  const literal = new Set(config.paths.filter((path) => !isGlob(path)))
  for (const { file, text } of contents) {
    if (text === undefined) {
      if (literal.has(file) && config.repos?.some((pattern) => stripForge(pattern) === repo.path))
        errors.push({ source: context.id, repo: repo.path, file, message: 'file not found' })
      continue
    }
    const size = Buffer.byteLength(text)
    if (size > config.maxFileBytes || read.bytes + size > config.maxBytes) {
      read.skipped = (read.skipped ?? 0) + 1
      errors.push({
        source: context.id,
        repo: repo.path,
        file,
        message: `skipped: ${size} bytes exceed ${size > config.maxFileBytes ? 'maxFileBytes' : 'maxBytes'}`,
      })
      continue
    }
    read.files++
    read.bytes += size
    const environment = environmentOf(config.environment, file)
    try {
      for (const found of extract(text, config.extract, { file })) {
        read.extracted++
        hits.push({
          ...found,
          occurrence: {
            source: context.id,
            role: config.role,
            repo: repo.path,
            file,
            ...(environment ? { environment } : {}),
          },
        })
      }
    } catch (error) {
      errors.push({
        source: context.id,
        repo: repo.path,
        file,
        message: `${config.extract.kind}: ${errorMessage(error)}`,
      })
    }
  }
  return { hits, read, errors }
}

/** Files of repositories, read through `GitForge.readFile`/`listFiles` without clones. */
export const filesSource = {
  kind: 'files',
  schema,
  async read(config, context): Promise<SourceResult> {
    const result: SourceResult = { hits: [], reads: [], errors: [], documents: [] }
    const { forge } = context
    if (!forge) {
      result.errors.push({ source: context.id, message: 'files sources need a forge' })
      return result
    }
    const repos = selectRepos(config, context, result.errors)
    const perRepo = await mapLimit(repos, context.concurrency, (repo) =>
      readRepo(forge, repo, config, context),
    )
    for (const { hits, read, errors } of perRepo) {
      result.hits.push(...hits)
      result.reads.push(read)
      result.errors.push(...errors)
    }
    return result
  },
} satisfies SourceProvider<FilesSourceConfig>
