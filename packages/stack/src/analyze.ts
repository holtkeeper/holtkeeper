import { posix } from 'node:path'

import type { CiVariable, GitForge, RepoRef } from '@holtkeeper/forge'
import { detectToolchainFrom, subProjects, type Tool } from '@holtkeeper/toolchain'

import { hasEnded, isLts } from './assess.ts'
import { type ComponentInfo, imageComponent, toolComponent } from './catalog.ts'
import {
  type CiInclude,
  ciIncludes,
  dockerfileReferences,
  isPrerelease,
  nameVersion,
  parseImageRef,
  type References,
  tagVersion,
  variablesOf,
  variantFamily,
  yamlReferences,
} from './references.ts'
import type { VersionSources } from './sources.ts'
import type {
  StackComponent,
  StackData,
  StackNote,
  StackRepo,
  StackUsage,
  UsageVia,
} from './types.ts'
import { compareVersionText, parseVersion } from './version.ts'

/** The forge calls the analysis makes; it never clones. */
export type StackForge = Pick<
  GitForge,
  'readFile' | 'getRepository' | 'listFiles' | 'listCiVariables' | 'listImageTags'
>

export interface AnalyzeStackOptions {
  /** Group name, stored as the record's subject. */
  group: string
  repos: RepoRef[]
  forge: StackForge
  /** Omit to skip every lookup: no latest versions, no lifecycles. */
  sources?: VersionSources
  /** Component ids or names to leave out; `*` matches any run of characters. */
  ignore?: string[]
  /** Image, compose, CI and deployment files read per repository. Default 50. */
  maxFiles?: number
  /** Days before an end of life that count as soon. Default 180. */
  soonDays?: number
  /** Repositories read in parallel. Default 4. */
  concurrency?: number
  /** Default now. */
  now?: Date
  log?: (line: string) => void
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

const skippedDirs = new Set([
  'node_modules',
  'vendor',
  'target',
  'dist',
  'build',
  'out',
  'fixtures',
  '__fixtures__',
  'testdata',
])
const deployDirs = new Set([
  'k8s',
  'kubernetes',
  'manifests',
  'deploy',
  'deployment',
  'helm',
  'charts',
])

/** Which kind of file a repository path is for the analysis, or `undefined` when it is not read. */
export function classifyFile(path: string): Exclude<UsageVia, 'version-file'> | undefined {
  const segments = path.split('/')
  const base = segments.at(-1) ?? ''
  const dirs = segments.slice(0, -1)
  if (
    dirs.some(
      (dir) =>
        skippedDirs.has(dir) || (dir.startsWith('.') && dir !== '.github' && dir !== '.gitlab'),
    )
  )
    return undefined
  if (
    /^(dockerfile|containerfile)(\.[\w.-]+)?$/i.test(base) ||
    /\.(dockerfile|containerfile)$/i.test(base)
  )
    return 'dockerfile'
  const yaml = /\.ya?ml$/i.test(base)
  if (!yaml) return undefined
  if (/^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i.test(base)) return 'compose'
  if (base === '.gitlab-ci.yml' || dirs[0] === '.gitlab' || path.startsWith('.github/workflows/'))
    return 'ci'
  if (dirs.includes('templates')) return undefined
  if (/^values(\.[\w-]+)?\.ya?ml$/i.test(base) || dirs.some((dir) => deployDirs.has(dir)))
    return 'deploy'
  return undefined
}

const fallbackFiles = [
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  '.gitlab-ci.yml',
]

/** A tool version as a comparable version: `v20.1` → `20.1`, `20.x` → `20`, `temurin-21.0.2` → `21.0.2`. */
export function toolVersion(tool: string, declared: string): string | undefined {
  let value = declared.trim()
  if (tool === 'java') value = value.replace(/^[a-z][a-z-]*-(?=\d)/i, '')
  value = value.replace(/^v(?=\d)/, '').replace(/(\.[x*])+$/i, '')
  return /^\d+(\.\d+){0,3}$/.test(value) ? value : undefined
}

interface Found {
  info: ComponentInfo
  usage: StackUsage
}

interface RepoScan {
  repo: StackRepo
  found: Found[]
  notes: StackNote[]
}

function toolFound(
  repo: string,
  file: string,
  via: UsageVia,
  tool: Pick<Tool, 'name' | 'version'>,
): Found {
  const version = toolVersion(tool.name, tool.version)
  return {
    info: toolComponent(tool.name),
    usage: { repo, file, via, declared: tool.version, ...(version ? { version } : {}) },
  }
}

function imageFound(repo: string, file: string, via: UsageVia, ref: string): Found | undefined {
  const image = parseImageRef(ref)
  if (!image) return undefined
  const named = nameVersion(image.repository)
  if (named)
    return {
      info: toolComponent(named.tool),
      usage: {
        repo,
        file,
        via,
        declared: `${image.repository.split('/').at(-1)}:${image.tag ?? 'latest'}`,
        version: named.version,
        ...(named.variant ? { variant: named.variant } : {}),
        image: ref,
      },
    }
  const { version, variant } = tagVersion(image.tag)
  return {
    info: imageComponent(image),
    usage: {
      repo,
      file,
      via,
      declared: image.tag ?? (image.digest ? `@${image.digest.slice(0, 19)}` : 'latest'),
      ...(version ? { version } : {}),
      ...(variant ? { variant } : {}),
      image: ref,
    },
  }
}

/** What repositories of one run share: group variables and files of other projects. */
interface Shared {
  groupVariables: Map<string, Promise<CiVariable[] | undefined>>
  projectFiles: Map<string, Promise<string | undefined>>
  /** Repositories and groups whose CI/CD variables the token could not read. */
  unreadable: { repos: Set<string>; groups: Set<string> }
}

const isGitLabCi = (file: string) =>
  posix.basename(file) === '.gitlab-ci.yml' || file.startsWith('.gitlab/')

/** Variables by key, `*`-scoped ones winning over environment-scoped ones. */
function variableMap(variables: CiVariable[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const variable of variables)
    if (!(variable.key in map) || variable.environmentScope === '*')
      map[variable.key] = variable.value
  return map
}

/**
 * The CI/CD variables a repository's pipelines receive from the forge: its groups' from the top
 * down, then its own, over GitLab's predefined project variables.
 */
async function ciVariables(
  forge: StackForge,
  path: string,
  defaultBranch: string | undefined,
  shared: Shared,
): Promise<Record<string, string>> {
  const segments = path.split('/')
  const predefined: Record<string, string> = {
    CI_PROJECT_PATH: path,
    CI_PROJECT_NAME: segments.at(-1) ?? path,
    CI_PROJECT_NAMESPACE: segments.slice(0, -1).join('/'),
    CI_PROJECT_ROOT_NAMESPACE: segments[0] ?? path,
    ...(defaultBranch ? { CI_DEFAULT_BRANCH: defaultBranch } : {}),
  }
  const list = forge.listCiVariables?.bind(forge)
  if (!list) return predefined
  const groups = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'))
  const groupLists = await Promise.all(
    groups.map((group) => {
      let pending = shared.groupVariables.get(group)
      if (!pending) {
        pending = list({ kind: 'group', path: group }).catch(() => undefined)
        shared.groupVariables.set(group, pending)
      }
      return pending
    }),
  )
  const own = await list({ kind: 'repo', path }).catch(() => undefined)
  groups.forEach((group, index) => {
    if (!groupLists[index]) shared.unreadable.groups.add(group)
  })
  if (!own) shared.unreadable.repos.add(path)
  return Object.assign(
    predefined,
    ...groupLists.map((variables) => variableMap(variables ?? [])),
    variableMap(own ?? []),
  )
}

const globPattern = (glob: string) =>
  new RegExp(
    `^${glob
      .split(/(\*\*\/?|\*)/)
      .map((part) =>
        part.startsWith('**')
          ? '(?:.*/)?'
          : part === '*'
            ? '[^/]*'
            : part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'),
      )
      .join('')}$`,
  )

async function scanRepo(
  forge: StackForge,
  ref: RepoRef,
  maxFiles: number,
  shared: Shared,
): Promise<RepoScan> {
  const path = ref.path
  const scan: RepoScan = { repo: { path, files: [] }, found: [], notes: [] }
  let defaultBranch: string | undefined
  try {
    const info = await forge.getRepository(path)
    scan.repo.webUrl = info.webUrl
    defaultBranch = info.defaultBranch
    if (info.archived) {
      scan.repo.archived = true
      return scan
    }
  } catch (error) {
    scan.repo.error = message(error)
    return scan
  }

  let files: string[] | undefined
  if (forge.listFiles) {
    try {
      const entries = await forge.listFiles(path, { recursive: true, limit: 10_000 })
      files = entries.filter((entry) => entry.type !== 'dir').map((entry) => entry.path)
    } catch (error) {
      scan.notes.push({ repo: path, message: `files could not be listed: ${message(error)}` })
    }
  }
  const read = async (file: string) => {
    try {
      return await forge.readFile(path, file)
    } catch (error) {
      scan.notes.push({ repo: path, message: `${file} could not be read: ${message(error)}` })
      return undefined
    }
  }
  const parse = (file: string, text: string): unknown => {
    try {
      return Bun.YAML.parse(text)
    } catch (error) {
      scan.notes.push({ repo: path, message: `${file} could not be parsed: ${message(error)}` })
      return undefined
    }
  }
  const record = (file: string, via: UsageVia, references: References) => {
    if (!scan.repo.files.includes(file)) scan.repo.files.push(file)
    for (const reference of references.references) {
      const found =
        reference.type === 'image'
          ? imageFound(path, file, via, reference.ref)
          : toolFound(path, file, via, { name: reference.tool, version: reference.declared })
      if (found) scan.found.push(found)
      else if (reference.type === 'image')
        scan.notes.push({ repo: path, message: `${file}: cannot parse image "${reference.ref}"` })
    }
    for (const value of references.unresolved)
      scan.notes.push({
        repo: path,
        message: `${file}: "${value}" uses variables that could not be expanded`,
      })
  }

  const projects = ['', ...subProjects(files ?? [])]
  for (const project of projects) {
    // oxlint-disable-next-line no-await-in-loop -- projects are few; reads inside run one by one anyway
    const toolchain = await detectToolchainFrom((file) => read(posix.join(project, file)), [])
    for (const tool of toolchain.tools) {
      const implied = toolchain.notes.includes(
        `${tool.name} ${tool.version}: no version pinned, implied by ${tool.source}`,
      )
      if (implied && project) continue
      const file = posix.join(project, tool.source)
      scan.found.push(toolFound(path, file, 'version-file', tool))
      if (!scan.repo.files.includes(file)) scan.repo.files.push(file)
    }
    const manager = toolchain.packageManager
    if (manager?.name === 'npm' && manager.version)
      scan.found.push(
        toolFound(path, posix.join(project, 'package.json'), 'version-file', {
          name: 'npm',
          version: manager.version,
        }),
      )
  }

  const candidates = (files ?? fallbackFiles)
    .map((file) => ({ file, via: classifyFile(file) }))
    .filter(
      (entry): entry is { file: string; via: Exclude<UsageVia, 'version-file'> } => !!entry.via,
    )
    .toSorted(
      (a, b) => a.file.split('/').length - b.file.split('/').length || a.file.localeCompare(b.file),
    )
  if (candidates.length > maxFiles)
    scan.notes.push({
      repo: path,
      message: `read ${maxFiles} of ${candidates.length} image, CI and deployment files (maxFiles)`,
    })
  const shown = candidates.slice(0, maxFiles)
  const texts = new Map(
    await Promise.all(shown.map(async ({ file }) => [file, await read(file)] as const)),
  )
  const ci = shown.some(({ file }) => isGitLabCi(file))
    ? await ciVariables(forge, path, defaultBranch, shared)
    : {}

  // A GitLab pipeline: the entry file and everything it includes, with variables merged so the
  // entry file wins over its includes.
  const done = new Set<string>()
  const pipeline = async (entry: string) => {
    const tree: { label: string; document: unknown }[] = []
    const seen = new Set<string>()
    const visit = async (label: string, text: string | undefined, depth: number) => {
      if (text === undefined || seen.has(label) || tree.length >= 30) return
      seen.add(label)
      const document = parse(label, text)
      if (document === undefined) return
      const { includes, skipped } = ciIncludes(document)
      for (const value of skipped)
        scan.notes.push({ repo: path, message: `${label}: include ${value} was not read` })
      if (depth < 4)
        for (const include of includes)
          // oxlint-disable-next-line no-await-in-loop -- includes merge in order
          await visitInclude(include, depth + 1)
      tree.push({ label, document })
    }
    const visitInclude = async (include: CiInclude, depth: number) => {
      if (include.type === 'local') {
        const matches = include.file.includes('*')
          ? (files ?? []).filter((file) => globPattern(include.file).test(file))
          : [include.file]
        for (const file of matches)
          // oxlint-disable-next-line no-await-in-loop -- includes merge in order
          await visit(file, texts.get(file) ?? (await read(file)), depth)
        return
      }
      const key = `${include.project}@${include.ref ?? ''}:${include.file}`
      let pending = shared.projectFiles.get(key)
      if (!pending) {
        pending = forge.readFile(include.project, include.file, include.ref).catch(() => undefined)
        shared.projectFiles.set(key, pending)
      }
      const text = await pending
      if (text === undefined)
        scan.notes.push({
          repo: path,
          message: `include ${include.project}:${include.file} could not be read`,
        })
      await visit(`${include.project}:${include.file}`, text, depth)
    }
    await visit(entry, texts.get(entry), 0)
    const variables = Object.assign(
      {},
      ...tree.map(({ document }) =>
        variablesOf(
          typeof document === 'object' && document !== null
            ? Reflect.get(document, 'variables')
            : undefined,
        ),
      ),
    )
    for (const { label } of tree) done.add(label)
    return { tree, variables }
  }

  const root = texts.has('.gitlab-ci.yml') ? await pipeline('.gitlab-ci.yml') : undefined
  const pipelines = root ? [root] : []
  for (const { file } of shown)
    if (isGitLabCi(file) && !done.has(file)) {
      // oxlint-disable-next-line no-await-in-loop -- child pipelines share the include cache
      const child = await pipeline(file)
      // Child pipelines receive the parent's global variables, which win over their own.
      pipelines.push({ tree: child.tree, variables: { ...child.variables, ...root?.variables } })
    }
  for (const { tree, variables } of pipelines)
    for (const { label, document } of tree)
      record(label, 'ci', yamlReferences(document, { inherited: variables, ci }))

  for (const { file, via } of shown) {
    const text = texts.get(file)
    if (text === undefined || done.has(file) || isGitLabCi(file)) continue
    if (via === 'dockerfile') {
      record(file, via, dockerfileReferences(text))
      continue
    }
    const document = parse(file, text)
    if (document !== undefined) record(file, via, yamlReferences(document))
  }
  return scan
}

const globToRegExp = (glob: string) =>
  new RegExp(
    `^${glob
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  )

const highest = (versions: (string | undefined)[]) =>
  versions
    .filter((version): version is string => !!version)
    .toSorted(compareVersionText)
    .at(-1)

/**
 * The newest release tag of an image: versions only, no prereleases, in the variant family most
 * usages use (plain tags first), most precise among equal versions.
 */
export function latestTag(tags: string[], families: string[]): string | undefined {
  const parsed = tags
    .map((tag) => ({ tag, ...tagVersion(tag) }))
    .filter((entry) => entry.version && !isPrerelease(entry.variant))
  const counts = new Map<string, number>()
  for (const family of families) counts.set(family, (counts.get(family) ?? 0) + 1)
  const preferred = [...counts].toSorted((a, b) => b[1] - a[1] || a[0].length - b[0].length)
  for (const family of ['', ...preferred.map(([name]) => name)]) {
    const matching = parsed.filter((entry) => variantFamily(entry.variant) === family)
    const newest = highest(matching.map((entry) => entry.version))
    if (newest) return newest
  }
  return undefined
}

async function resolveLatest(
  component: StackComponent,
  info: ComponentInfo,
  sources: VersionSources,
  at: Date,
): Promise<Partial<StackComponent>> {
  const lookup = info.lookup
  if (lookup.type === 'endoflife') {
    const cycles = await sources.lifecycle(lookup.product)
    if (!cycles) return {}
    const latest = highest(cycles.map((cycle) => cycle.latest ?? cycle.cycle))
    const latestLts = highest(
      cycles
        .filter((cycle) => isLts(cycle, at) && !hasEnded(cycle, at))
        .map((cycle) => cycle.latest),
    )
    return {
      cycles,
      ...(latest ? { latest } : {}),
      ...(latestLts ? { latestLts } : {}),
      source: `endoflife.date/${lookup.product}`,
    }
  }
  if (lookup.type === 'npm' || lookup.type === 'pypi') {
    const latest = await sources[lookup.type](lookup.name)
    return latest ? { latest, source: `${lookup.type}/${lookup.name}` } : {}
  }
  if (lookup.type === 'image') {
    const image =
      lookup.registry && lookup.repository
        ? { registry: lookup.registry, repository: lookup.repository }
        : component.usages.map((usage) => usage.image && parseImageRef(usage.image)).find(Boolean)
    if (!image) return {}
    const tags = await sources.imageTags(image.registry, image.repository)
    const families = component.usages.map((usage) => variantFamily(usage.variant))
    const latest = tags ? latestTag(tags, families) : undefined
    return latest ? { latest, source: `${image.registry}/${image.repository}` } : {}
  }
  return {}
}

/**
 * Reads version files, Dockerfiles, compose files, CI configs and deployment manifests of every
 * repository through the forge API, groups what they name into components and looks up latest
 * versions and release lines. Unreadable repositories and files end up in `notes` or the
 * repository's `error`; the rest of the fleet is still analyzed.
 */
export async function analyzeStack(options: AnalyzeStackOptions): Promise<StackData> {
  const {
    group,
    repos,
    forge,
    sources,
    ignore = [],
    maxFiles = 50,
    soonDays = 180,
    concurrency = 4,
    now = new Date(),
    log,
  } = options
  const shared: Shared = {
    groupVariables: new Map(),
    projectFiles: new Map(),
    unreadable: { repos: new Set(), groups: new Set() },
  }
  const scans = await mapLimit(repos, concurrency, (ref) => {
    log?.(`reading ${ref.path}`)
    return scanRepo(forge, ref, maxFiles, shared)
  })
  const ignored = ignore.map(globToRegExp)
  const isIgnored = (info: ComponentInfo) =>
    ignored.some((pattern) => pattern.test(info.id) || pattern.test(info.name))

  const byId = new Map<string, { info: ComponentInfo; component: StackComponent }>()
  for (const { info, usage } of scans.flatMap((scan) => scan.found)) {
    if (isIgnored(info)) continue
    const entry = byId.get(info.id) ?? {
      info,
      component: { id: info.id, name: info.name, kind: info.kind, usages: [] },
    }
    entry.component.usages.push(usage)
    byId.set(info.id, entry)
  }

  const forgeTags = forge.listImageTags?.bind(forge)
  const lookups: VersionSources | undefined = sources && {
    ...sources,
    imageTags: async (registry, repository) =>
      (registry !== 'docker.io' && forgeTags
        ? await forgeTags(`${registry}/${repository}`).catch(() => undefined)
        : undefined) ?? sources.imageTags(registry, repository),
  }
  const components = await mapLimit([...byId.values()], 8, async ({ info, component }) => {
    if (!lookups) return component
    log?.(`looking up ${component.id}`)
    return { ...component, ...(await resolveLatest(component, info, lookups, now)) }
  })
  const notes = scans.flatMap((scan) => scan.notes)
  const { unreadable } = shared
  if (
    (unreadable.repos.size || unreadable.groups.size) &&
    notes.some((note) => note.message.includes('could not be expanded'))
  )
    notes.push({
      message: `CI/CD variables could not be read for ${[
        unreadable.repos.size ? `${unreadable.repos.size} of ${scans.length} repositories` : '',
        unreadable.groups.size ? `groups ${[...unreadable.groups].toSorted().join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' and ')}; the token needs maintainer access there to expand them`,
    })
  for (const component of components)
    if (
      sources &&
      !component.latest &&
      component.usages.some((usage) => parseVersion(usage.version ?? ''))
    )
      notes.push({
        message: `latest version of ${component.name} is unknown; lag is not shown for it`,
      })

  const unique = new Map(notes.map((note) => [`${note.repo ?? ''}\0${note.message}`, note]))

  return {
    group,
    checkedAt: now.toISOString(),
    soonDays,
    repos: scans.map((scan) => scan.repo),
    components: components.toSorted(
      (a, b) =>
        new Set(b.usages.map((usage) => usage.repo)).size -
          new Set(a.usages.map((usage) => usage.repo)).size || a.name.localeCompare(b.name),
    ),
    notes: [...unique.values()],
  }
}
