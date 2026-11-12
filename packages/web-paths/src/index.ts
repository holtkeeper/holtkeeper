type Search = Readonly<Record<string, string | undefined>>

const withSearch = (path: string, search: Search = {}) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) if (value) params.set(key, value)
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

const segment = encodeURIComponent

/** Filters of Ops › Runs. */
interface RunsSearch {
  repo?: string
  status?: string
  analyzer?: string
  trigger?: string
  schedule?: string
  signature?: string
  view?: string
}

/** Tabs of the repository hub; `overview` is the default. */
type RepoHubTab =
  | 'overview'
  | 'supply'
  | 'quality'
  | 'releases'
  | 'activity'
  | 'knowledge'
  | 'settings'

/**
 * What a repository hub link opens: a tab, an area of it (`section`, e.g. `assets` on Quality or
 * `updates` on Settings), and a file at a ref for areas that show one.
 */
interface RepoHubSearch {
  tab?: RepoHubTab
  section?: string
  file?: string
  ref?: string
}

/** `/repos/<forge>/<path>` for a `forge:path` key, each segment encoded on its own. */
const repoHubPath = (repo: string) => {
  const separator = repo.indexOf(':')
  const forge = repo.slice(0, Math.max(separator, 0))
  const path = repo.slice(separator + 1)
  return `/repos/${[forge, ...path.split('/')].map(segment).join('/')}`
}

/** Selection of Ops › Tasks: a task group, one task of it, a status filter. */
interface TasksSearch {
  group?: string
  task?: string
  filter?: string
}

/** Tabs of the Knowledge workspace. */
type KnowledgeSection = 'guide' | 'notes' | 'learnings'

/**
 * What a Knowledge link opens: a space (a Guide scope key: `all`, `group:<g>`, `family:<id>`,
 * `repo:<forge>:<path>`), a Guide section of it, a note by id.
 */
interface KnowledgeSearch {
  space?: string
  section?: string
  note?: string
}

/** Kinds of Inbox items, as the Inbox's kind filter names them. */
type InboxKindFilter = 'task' | 'note' | 'learning' | 'guide' | 'release' | 'allowlist'

/** What an Inbox link opens: an item by its id, a kind filter, the Snoozed tab. */
interface InboxSearch {
  item?: string
  kind?: InboxKindFilter
  tab?: 'snoozed'
}

/** Sections of Settings. */
type SettingsSection =
  | 'people'
  | 'ai'
  | 'integrations'
  | 'analyzers'
  | 'policies'
  | 'system'
  | 'audit'

/**
 * Paths of panel pages, relative to the panel's origin and starting with `/`. Search parameters
 * that are empty or `undefined` are left out; values are URL-encoded. Repository keys are
 * `forge:path`; the repository hub puts them in the path as `/repos/<forge>/<path>`.
 */
export const webPaths = {
  inbox: (search: InboxSearch = {}) => withSearch('/inbox', { ...search }),
  repos: () => '/repos',
  repo: (repo: string, search: RepoHubSearch = {}) => withSearch(repoHubPath(repo), { ...search }),
  groups: () => '/repos/groups',
  security: () => '/supply/security',
  securityRun: (runId: string) => `/supply/security/runs/${segment(runId)}`,
  releaseTimeline: (repo: string) => withSearch('/releases/timeline', { repo }),
  knowledge: (tab: KnowledgeSection, search: KnowledgeSearch = {}) =>
    withSearch(`/knowledge/${tab}`, { ...search }),
  chat: (thread?: string) => withSearch('/chat', { thread }),
  runs: (search: RunsSearch = {}) => withSearch('/ops/runs', { ...search }),
  tasks: (search: TasksSearch = {}) =>
    withSearch('/ops/tasks', {
      group: search.group,
      task: search.group ? search.task : undefined,
      filter: search.filter,
    }),
  automation: (job?: string) => withSearch('/ops/automation', { job }),
  settings: (section: SettingsSection) => `/settings/${section}`,
} as const

/** `path` of `webPaths` as an absolute URL on the panel at `publicUrl`; trailing slashes are ignored. */
export const webUrl = (publicUrl: string, path: string): string =>
  `${publicUrl.replace(/\/+$/, '')}${path}`
