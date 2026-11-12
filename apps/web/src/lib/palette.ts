import type {
  DependencySearchHit,
  PublicApiSymbolHit,
  RepoHealthCells,
  RepoHealthStatus,
  RepoSummary,
  UserView,
} from '@holtkeeper/api'
import type { LinkProps } from '@tanstack/react-router'

import { healthCells } from './home.ts'
import { repoKey, repoSplat } from './repo.ts'
import type { SettingsSearchEntry } from './settings-search.ts'

/** Where a result comes from; also the palette's filter chips, in display order. */
export const paletteKinds = [
  'repos',
  'libraries',
  'pages',
  'settings',
  'actions',
  'people',
  'recent',
] as const

export type PaletteKind = (typeof paletteKinds)[number]

/** A filter chip: everything, or one kind. */
export type PaletteFilter = 'all' | PaletteKind

/** Commands the palette runs instead of opening a page. */
type PaletteActionId = 'theme' | 'docs' | 'sign-out' | 'new-thread'

/** The status a repository result shows, from its overall health. */
export type PaletteTone = 'ok' | 'warning' | 'danger' | 'none'

/** A repository's state for the preview: its health cells and the tone of its overall health. */
export interface PaletteRepoState {
  key: string
  forge: string
  path: string
  groups: string[]
  tone: PaletteTone
  cells: RepoHealthCells
}

/** One result: a page to open or an action to run. Everything but `action` survives JSON. */
export interface PaletteItem {
  /** `<kind>:<key>`, unique across sources. */
  id: string
  kind: Exclude<PaletteKind, 'recent'>
  title: string
  subtitle?: string
  /** Short text on the right: a version, `Page`, a status. */
  meta?: string
  tone?: PaletteTone
  /** Monospace title, for paths and symbols. */
  mono?: boolean
  /** Extra words that match without being shown. */
  keywords?: string
  link?: LinkProps
  action?: PaletteActionId
  repo?: PaletteRepoState
}

/** A result group in the list. */
interface PaletteGroup {
  kind: PaletteKind
  label: string
  items: PaletteItem[]
  /** Matches before the group was cut to its limit. */
  total: number
}

/** What the palette shows for a query and filter. */
export interface PaletteResults {
  groups: PaletteGroup[]
  /** Matches per kind before limits, for the chips. */
  counts: Record<PaletteKind, number>
  /** Every shown item in display order, for ↑ ↓ and ↵. */
  flat: PaletteItem[]
}

const groupLabels: Record<PaletteKind, string> = {
  repos: 'Repositories',
  libraries: 'Libraries and symbols',
  pages: 'Pages',
  settings: 'Settings',
  actions: 'Actions',
  people: 'People',
  recent: 'Recent',
}

/** Chip text of each filter. */
export const filterLabels: Record<PaletteFilter, string> = {
  all: 'All',
  repos: 'Repositories',
  libraries: 'Libraries',
  pages: 'Pages',
  settings: 'Settings',
  actions: 'Actions',
  people: 'People',
  recent: 'Recent',
}

const prefixes: Record<string, PaletteKind> = { '>': 'actions', '#': 'repos', '@': 'people' }

/**
 * Splits a typed query into its text and the kind a leading `>` (actions), `#` (repositories) or
 * `@` (people) asks for.
 */
export function parseQuery(raw: string): { text: string; kind?: PaletteKind } {
  const trimmed = raw.trimStart()
  const kind = prefixes[trimmed.charAt(0)]
  return kind ? { text: trimmed.slice(1).trim(), kind } : { text: trimmed.trim() }
}

const normalize = (value: string) => value.toLowerCase()

/**
 * How well `item` matches `query` (lower is better): 0 title prefix, 1 a word of the title starts
 * with it, 2 title contains it, 3 every word is somewhere in title, subtitle or keywords;
 * `undefined` when it does not match. An empty query matches everything with 0.
 */
export function scoreItem(item: PaletteItem, query: string): number | undefined {
  const q = normalize(query.trim())
  if (!q) return 0
  const title = normalize(item.title)
  if (title.startsWith(q)) return 0
  if (title.split(/[\s/.:›@_-]+/).some((word) => word.startsWith(q))) return 1
  if (title.includes(q)) return 2
  const haystack = normalize([item.title, item.subtitle, item.keywords].filter(Boolean).join(' '))
  return q.split(/\s+/).every((word) => haystack.includes(word)) ? 3 : undefined
}

/** `title` split around the first case-insensitive occurrence of `query`, for highlighting. */
export function highlight(
  title: string,
  query: string,
): { pre: string; hit: string; post: string } {
  const q = query.trim()
  const at = q ? normalize(title).indexOf(normalize(q)) : -1
  if (at < 0) return { pre: title, hit: '', post: '' }
  return {
    pre: title.slice(0, at),
    hit: title.slice(at, at + q.length),
    post: title.slice(at + q.length),
  }
}

/** Items matching `query`, best first; ties keep the source order. */
export function rankItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  return items
    .flatMap((item, order) => {
      const score = scoreItem(item, query)
      return score === undefined ? [] : [{ item, order, score }]
    })
    .toSorted((a, b) => a.score - b.score || a.order - b.order)
    .map(({ item }) => item)
}

const allLimit = 5
const filteredLimit = 50

/**
 * The groups to show. With the `all` filter each group keeps its best `5`; a single kind keeps
 * `50`. Without a query, `all` shows only recent items, pages and actions. Recent items already
 * shown in their own group are left out of Recent.
 */
export function buildResults(
  sources: Partial<Record<PaletteKind, readonly PaletteItem[]>>,
  query: string,
  filter: PaletteFilter,
): PaletteResults {
  const counts: Record<PaletteKind, number> = {
    repos: 0,
    libraries: 0,
    pages: 0,
    settings: 0,
    actions: 0,
    people: 0,
    recent: 0,
  }
  const ranked = new Map<PaletteKind, PaletteItem[]>()
  for (const kind of paletteKinds) {
    const matches = rankItems(sources[kind] ?? [], query)
    counts[kind] = matches.length
    ranked.set(kind, matches)
  }
  const empty = !query.trim()
  const shownKinds = paletteKinds.filter((kind) =>
    filter === 'all'
      ? !empty || kind === 'recent' || kind === 'pages' || kind === 'actions'
      : kind === filter,
  )
  const limit = filter === 'all' ? allLimit : filteredLimit
  const seen = new Set<string>()
  const groups: PaletteGroup[] = []
  for (const kind of shownKinds) {
    const matches = ranked.get(kind) ?? []
    const items = (
      kind === 'recent' && filter === 'all' ? matches.filter((item) => !seen.has(item.id)) : matches
    ).slice(0, limit)
    for (const item of items) seen.add(item.id)
    if (items.length) groups.push({ kind, label: groupLabels[kind], items, total: matches.length })
  }
  const recent = groups.filter((group) => group.kind === 'recent')
  const rest = groups.filter((group) => group.kind !== 'recent')
  const ordered = empty ? [...recent, ...rest] : [...rest, ...recent]
  return { groups: ordered, counts, flat: ordered.flatMap((group) => group.items) }
}

/** The index `delta` steps from `index` in a list of `length`, wrapping around; -1 when empty. */
export const moveSelection = (index: number, delta: number, length: number): number =>
  length ? (((index + delta) % length) + length) % length : -1

/** True for ⌘K or Ctrl+K without Shift or Alt: the key that opens the palette from anywhere. */
export const isPaletteShortcut = (event: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}): boolean =>
  event.key.toLowerCase() === 'k' &&
  Boolean(event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey

const healthTones: Record<RepoHealthStatus, PaletteTone> = {
  failing: 'danger',
  warnings: 'warning',
  healthy: 'ok',
  'not-analysed': 'none',
}

/** Words for a repository's overall tone. */
export const toneLabels: Record<PaletteTone, string> = {
  danger: 'Failing',
  warning: 'Warnings',
  ok: 'Healthy',
  none: 'Not analysed',
}

/**
 * One result per readable repository, toned by its overall health. The subtitle names its groups
 * and the health cells that need attention.
 */
export function repoItems(repos: readonly RepoSummary[]): PaletteItem[] {
  return repos.map((summary): PaletteItem => {
    const key = repoKey(summary.repo)
    const tone = healthTones[summary.health]
    const notes = healthCells.flatMap(({ key: cellKey, label }) => {
      const cell = summary.cells[cellKey]
      return cell && (cell.tone === 'bad' || cell.tone === 'warn') ? [`${label} ${cell.value}`] : []
    })
    return {
      id: `repos:${key}`,
      kind: 'repos',
      title: summary.repo.path,
      subtitle: [summary.groups.join(', '), toneLabels[tone], ...notes].filter(Boolean).join(' · '),
      meta: toneLabels[tone],
      tone,
      mono: true,
      keywords: `${summary.repo.forge} ${summary.groups.join(' ')}`,
      link: { to: '/repos/$', params: { _splat: repoSplat(summary.repo) } },
      repo: { key, ...summary.repo, groups: summary.groups, tone, cells: summary.cells },
    }
  })
}

/** One result per library search hit, linking to the library page. */
export function libraryItems(libraries: readonly DependencySearchHit[]): PaletteItem[] {
  return libraries.map((library): PaletteItem => {
    const count = library.usedBy
    return {
      id: `libraries:${library.ecosystem}:${library.name}`,
      kind: 'libraries',
      title: library.name,
      subtitle: `${library.internal ? 'Internal library' : 'Library'} · ${library.ecosystem} · used in ${count} ${count === 1 ? 'repository' : 'repositories'}`,
      ...(library.latest ? { meta: library.latest } : {}),
      mono: true,
      link: {
        to: '/supply/libraries/$ecosystem/$',
        params: { ecosystem: library.ecosystem, _splat: library.name },
      },
    }
  })
}

/** One result per exported symbol hit, opening its sheet on the Public API page. */
export function symbolItems(hits: readonly PublicApiSymbolHit[]): PaletteItem[] {
  return hits.map((hit): PaletteItem => {
    const at = `${hit.package}${hit.version ? `@${hit.version}` : ''}`
    return {
      id: `libraries:symbol:${at}:${hit.importPath}:${hit.symbol.name}`,
      kind: 'libraries',
      title: hit.symbol.name,
      subtitle: `${hit.symbol.kind} · ${hit.importPath}${hit.version ? ` ${hit.version}` : ''}`,
      meta: 'Public API',
      mono: true,
      keywords: hit.package,
      link: {
        to: '/supply/public-api',
        search: {
          tab: 'search',
          q: hit.symbol.name,
          symbol: `${hit.importPath}:${hit.symbol.name}`,
          repo: repoKey(hit.repo),
          ...(hit.version ? { version: hit.version } : {}),
        },
      },
    }
  })
}

/** A workspace with its pages, as `groupByWorkspace` returns them. */
export interface PalettePageGroup {
  workspace: { label: string; title?: string }
  items: readonly { label: string; link: LinkProps; key: string }[]
}

/** One result per page the principal can open, titled `Workspace › Page`. */
export function pageItems(groups: readonly PalettePageGroup[]): PaletteItem[] {
  return groups.flatMap(({ workspace, items }) =>
    items.map((item): PaletteItem => {
      const name = workspace.title ?? workspace.label
      return {
        id: `pages:${item.key}`,
        kind: 'pages',
        title: item.label === name ? name : `${name} › ${item.label}`,
        meta: 'Page',
        link: item.link,
      }
    }),
  )
}

/** One result per Settings section and setting of the settings index. */
export function settingItems(entries: readonly SettingsSearchEntry[]): PaletteItem[] {
  return entries.map((entry): PaletteItem => ({
    id: `settings:${entry.id}`,
    kind: 'settings',
    title: entry.kind === 'section' ? entry.where : entry.label,
    subtitle:
      entry.kind === 'section' ? entry.description : `${entry.where} · ${entry.description}`,
    meta: 'Settings',
    keywords: entry.text,
    link: entry.link as LinkProps,
  }))
}

/** One result per account, opening Settings › People. */
export function peopleItems(users: readonly UserView[]): PaletteItem[] {
  return users.map((user): PaletteItem => ({
    id: `people:${user.id}`,
    kind: 'people',
    title: user.name,
    ...(user.email ? { subtitle: user.email } : {}),
    ...(user.disabled ? { meta: 'Disabled' } : {}),
    link: { to: '/settings/$section', params: { section: 'people' }, search: { item: user.id } },
  }))
}

/** The actions available: theme, docs, sign out when the provider has sessions, a new chat thread. */
export function actionItems(options: {
  theme: 'light' | 'dark'
  signOut: boolean
  chat: boolean
}): PaletteItem[] {
  const next = options.theme === 'dark' ? 'light' : 'dark'
  return [
    {
      id: 'actions:theme',
      kind: 'actions',
      title: `Switch to ${next} theme`,
      subtitle: 'Saved in this browser',
      keywords: 'theme dark light appearance',
      action: 'theme',
    },
    {
      id: 'actions:docs',
      kind: 'actions',
      title: 'Open documentation',
      subtitle: 'The Holtkeeper docs in a new tab',
      keywords: 'docs help',
      action: 'docs',
    },
    ...(options.chat
      ? [
          {
            id: 'actions:new-thread',
            kind: 'actions',
            title: 'New chat thread',
            subtitle: 'Start a thread for the team, a group or one repository',
            keywords: 'chat ask',
            action: 'new-thread',
          } satisfies PaletteItem,
        ]
      : []),
    ...(options.signOut
      ? [
          {
            id: 'actions:sign-out',
            kind: 'actions',
            title: 'Sign out',
            keywords: 'log out logout',
            action: 'sign-out',
          } satisfies PaletteItem,
        ]
      : []),
  ]
}

/** The subset of `Storage` recent items need. */
export interface RecentStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** `localStorage`, or `undefined` where reading it throws. */
export function browserStorage(): RecentStorage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/** A page opened from the palette, newest first in storage. */
export interface RecentItem {
  id: string
  kind: PaletteItem['kind']
  title: string
  subtitle?: string
  mono?: boolean
  link: LinkProps
  openedAt: string
}

const recentPrefix = 'holtkeeper.palette.recent:'
const recentKey = (principal: string) => `${recentPrefix}${principal}`
const recentLimit = 8

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isItemKind = (value: unknown): value is PaletteItem['kind'] =>
  paletteKinds.some((kind) => kind !== 'recent' && kind === value)

const isRecent = (value: unknown): value is RecentItem =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.title === 'string' &&
  typeof value.openedAt === 'string' &&
  isItemKind(value.kind) &&
  isRecord(value.link) &&
  typeof value.link.to === 'string' &&
  value.link.to.startsWith('/')

/**
 * The recent items `principal` stored; empty when storage is missing, throws or holds anything
 * unexpected.
 */
export function readRecent(storage: RecentStorage | undefined, principal: string): RecentItem[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(recentKey(principal)) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, recentLimit) : []
  } catch {
    return []
  }
}

/**
 * Puts `item` first among the recent items (once, at most 8 kept) and returns the new list. Actions
 * are not recorded. A storage that throws leaves the list unsaved but still returned.
 */
export function recordRecent(
  storage: RecentStorage | undefined,
  principal: string,
  item: PaletteItem,
  now: Date = new Date(),
): RecentItem[] {
  const current = readRecent(storage, principal)
  if (!item.link) return current
  const entry: RecentItem = {
    id: item.id,
    kind: item.kind,
    title: item.title,
    ...(item.subtitle ? { subtitle: item.subtitle } : {}),
    ...(item.mono ? { mono: true } : {}),
    link: item.link,
    openedAt: now.toISOString(),
  }
  const next = [entry, ...current.filter((existing) => existing.id !== item.id)].slice(
    0,
    recentLimit,
  )
  try {
    storage?.setItem(recentKey(principal), JSON.stringify(next))
  } catch {
    return next
  }
  return next
}

/** Forgets the recent items of every principal, for sign-out. Never throws. */
export function clearRecent(storage: RecentStorage | undefined) {
  try {
    if (!storage) return
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    for (const key of keys) if (key?.startsWith(recentPrefix)) storage.removeItem(key)
  } catch {
    return
  }
}

/**
 * Recent items as results; `meta` says how long ago, via `ago`. An item is kept only while the
 * viewer can still reach it: its id is among `available`, or it is a library and `libraries` holds.
 */
export function recentItems(
  recent: readonly RecentItem[],
  ago: (at: string) => string,
  available: Partial<Record<PaletteKind, readonly PaletteItem[]>>,
  libraries: boolean,
): PaletteItem[] {
  const ids = new Set(
    Object.values(available).flatMap((items) => (items ?? []).map((item) => item.id)),
  )
  return recent
    .filter((entry) => (entry.kind === 'libraries' ? libraries : ids.has(entry.id)))
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
      ...(entry.mono ? { mono: true } : {}),
      meta: ago(entry.openedAt),
      link: entry.link,
    }))
}
