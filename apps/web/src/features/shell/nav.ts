import type { Action, CrossTeamLevel, Principal } from '@holtkeeper/api'
import type { LinkProps } from '@tanstack/react-router'
import {
  BookOpen,
  Bot,
  Boxes,
  ChartColumn,
  CircleDollarSign,
  CodeXml,
  FileSearch,
  FlaskConical,
  FolderGit2,
  GitBranch,
  HardDrive,
  History,
  Images,
  Layers,
  LayoutDashboard,
  Library,
  Inbox,
  Lightbulb,
  ListChecks,
  ListTree,
  type LucideIcon,
  MessageSquareCode,
  MessagesSquare,
  NotebookPen,
  Package,
  Plug,
  Radar,
  Rocket,
  Scale,
  Settings2,
  ShieldCheck,
  Sparkles,
  Timer,
  Users,
  Waypoints,
  Workflow,
} from 'lucide-react'

import { can, canCatalog, canGlobal, visibleSettingsSections } from '../../lib/access.ts'
import { analysisPages, stackRecords } from '../../lib/analyses.ts'
import {
  type SettingsSectionId,
  settingsSectionIds,
  settingsSections,
} from '../../lib/settings-sections.ts'

/** A group of pages that share one set of segmented tabs in the page header. */
export interface Workspace {
  id:
    | 'home'
    | 'repos'
    | 'chat'
    | 'supply'
    | 'quality'
    | 'releases'
    | 'knowledge'
    | 'ops'
    | 'settings'
  /** Short name under the rail icon, also the tabs' accessible name. */
  label: string
  /** Name in page titles and crumbs when it differs from `label`. */
  title?: string
  icon: LucideIcon
  /** Reached from the rail's bottom button instead of the workspace list. */
  bottom?: boolean
}

/** Workspaces in rail order; `settings` is the rail's bottom Settings button. */
const workspaces: readonly Workspace[] = [
  { id: 'home', label: 'Home', icon: LayoutDashboard },
  { id: 'repos', label: 'Repos', icon: FolderGit2 },
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'supply', label: 'Supply', title: 'Supply chain', icon: Package },
  { id: 'quality', label: 'Quality', icon: ChartColumn },
  { id: 'releases', label: 'Releases', icon: Rocket },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'ops', label: 'Ops', icon: Bot },
  { id: 'settings', label: 'Settings', icon: Settings2, bottom: true },
]

/** A page reachable from the shell, shown as a tab of its workspace. */
export interface NavItem {
  to:
    | '/'
    | '/inbox'
    | '/repos'
    | '/repos/groups'
    | '/chat'
    | '/supply/libraries'
    | '/supply/security'
    | '/supply/licenses'
    | '/supply/stack'
    | '/supply/public-api'
    | '/quality/coverage'
    | '/quality/bundles'
    | '/quality/assets'
    | '/quality/ci'
    | '/quality/branches'
    | '/quality/reviews'
    | '/releases'
    | '/releases/timeline'
    | '/releases/setup'
    | '/knowledge/guide'
    | '/knowledge/notes'
    | '/knowledge/learnings'
    | '/ops/runs'
    | '/ops/tasks'
    | '/ops/automation'
    | '/ops/spend'
    | '/settings/$section'
  /** The Settings section of a `/settings/$section` entry; its visibility follows `visibleSettingsSections`. */
  section?: SettingsSectionId
  workspace: Workspace['id']
  label: string
  icon: LucideIcon
  /** Hidden unless some grant allows this action, or one of these actions. */
  requires?: Action | readonly Action[]
  /** `requires` must come from a grant over everything, because the server checks it globally. */
  global?: boolean
  /** Catalog reach is enough (`canCatalog`), like the server's catalog check; replaces `requires`. */
  catalog?: boolean
  /** The count its tab shows: open Inbox decisions, or task groups waiting for approval. */
  badge?: NavBadge
}

/** What a tab's badge counts. */
export type NavBadge = 'inbox' | 'tasks'

/** How a tab's badge reads to screen readers after its count. */
export const navBadgeWord: Record<NavBadge, string> = {
  inbox: 'waiting',
  tasks: 'need approval',
}

const settingsEntries: Readonly<Record<SettingsSectionId, { icon: LucideIcon }>> = {
  people: { icon: Users },
  ai: { icon: Sparkles },
  integrations: { icon: Plug },
  analyzers: { icon: Radar },
  policies: { icon: ShieldCheck },
  system: { icon: HardDrive },
  audit: { icon: History },
}

const navItems: readonly NavItem[] = [
  { workspace: 'home', to: '/', label: 'Overview', icon: LayoutDashboard },
  { workspace: 'home', to: '/inbox', label: 'Inbox', icon: Inbox, badge: 'inbox' },
  {
    workspace: 'repos',
    to: '/repos',
    label: 'Repositories',
    icon: FolderGit2,
    requires: 'repos:read',
  },
  {
    workspace: 'repos',
    to: '/repos/groups',
    label: 'Groups',
    icon: Users,
    requires: 'repos:read',
  },
  {
    workspace: 'chat',
    to: '/chat',
    label: 'Chat',
    icon: MessagesSquare,
    requires: 'repos:read',
  },
  {
    workspace: 'supply',
    to: '/supply/libraries',
    label: 'Libraries',
    icon: Library,
    catalog: true,
  },
  {
    workspace: 'supply',
    to: '/supply/security',
    label: 'Security',
    icon: FileSearch,
    requires: 'audits:read',
  },
  {
    workspace: 'supply',
    to: '/supply/licenses',
    label: 'Licenses',
    icon: Scale,
    requires: 'analyses:read',
  },
  {
    workspace: 'supply',
    to: '/supply/stack',
    label: 'Stack',
    icon: Layers,
    catalog: true,
  },
  {
    workspace: 'supply',
    to: '/supply/public-api',
    label: 'Public API',
    icon: CodeXml,
    catalog: true,
  },
  {
    workspace: 'quality',
    to: '/quality/coverage',
    label: 'Coverage',
    icon: FlaskConical,
    requires: 'analyses:read',
  },
  {
    workspace: 'quality',
    to: '/quality/bundles',
    label: 'Bundles',
    icon: Boxes,
    requires: 'analyses:read',
  },
  {
    workspace: 'quality',
    to: '/quality/assets',
    label: 'Assets',
    icon: Images,
    requires: 'analyses:read',
  },
  {
    workspace: 'quality',
    to: '/quality/ci',
    label: 'CI',
    icon: Timer,
    requires: 'analyses:read',
  },
  {
    workspace: 'quality',
    to: '/quality/branches',
    label: 'Branches',
    icon: GitBranch,
    requires: 'analyses:read',
  },
  {
    workspace: 'quality',
    to: '/quality/reviews',
    label: 'Reviews',
    icon: MessageSquareCode,
    requires: 'analyses:read',
  },
  {
    workspace: 'releases',
    to: '/releases',
    label: 'Overview',
    icon: Rocket,
    requires: 'releases:read',
  },
  {
    workspace: 'releases',
    to: '/releases/timeline',
    label: 'Timeline',
    icon: ListTree,
    requires: 'releases:read',
  },
  {
    workspace: 'releases',
    to: '/releases/setup',
    label: 'Flow setup',
    icon: Waypoints,
    requires: 'releases:read',
  },
  {
    workspace: 'knowledge',
    to: '/knowledge/guide',
    label: 'Guide',
    icon: BookOpen,
    requires: 'knowledge:read',
  },
  {
    workspace: 'knowledge',
    to: '/knowledge/notes',
    label: 'Notes',
    icon: NotebookPen,
    requires: 'knowledge:read',
  },
  {
    workspace: 'knowledge',
    to: '/knowledge/learnings',
    label: 'Learnings',
    icon: Lightbulb,
    requires: 'knowledge:read',
  },
  {
    workspace: 'ops',
    to: '/ops/runs',
    label: 'Runs',
    icon: ListChecks,
    requires: 'analyses:read',
  },
  {
    workspace: 'ops',
    to: '/ops/tasks',
    label: 'Tasks',
    icon: Bot,
    requires: 'repos:read',
    badge: 'tasks',
  },
  {
    workspace: 'ops',
    to: '/ops/automation',
    global: true,
    label: 'Automation',
    icon: Workflow,
    requires: 'settings:read',
  },
  {
    workspace: 'ops',
    to: '/ops/spend',
    label: 'AI spend',
    icon: CircleDollarSign,
    requires: ['ai:read', 'ai:admin'],
  },
  ...settingsSectionIds.map((section): NavItem => ({
    workspace: 'settings',
    to: '/settings/$section',
    section,
    icon: settingsEntries[section].icon,
    label: settingsSections[section].label,
  })),
]

const allowed = (item: NavItem, principal: Principal, crossTeam: CrossTeamLevel) => {
  if (item.section) return visibleSettingsSections(principal).includes(item.section)
  if (item.catalog) return canCatalog(principal, crossTeam)
  if (!item.requires) return true
  const check = item.global ? canGlobal : can
  return (typeof item.requires === 'string' ? [item.requires] : item.requires).some((action) =>
    check(principal, action),
  )
}

/** Navigation entries the principal can use at the given cross-team level. */
export const visibleNav = (principal: Principal, crossTeam: CrossTeamLevel): NavItem[] =>
  navItems.filter((item) => allowed(item, principal, crossTeam))

/** `items` grouped under their workspaces in rail order; workspaces left without items are dropped. */
/** The entries the palette lists as pages; Settings sections come from the settings index instead. */
export const paletteNav = (items: readonly NavItem[]): NavItem[] =>
  items.filter((item) => !item.section)

export const groupByWorkspace = (
  items: readonly NavItem[],
): { workspace: Workspace; items: NavItem[] }[] =>
  workspaces.flatMap((workspace) => {
    const entries = items.filter((item) => item.workspace === workspace.id)
    return entries.length ? [{ workspace, items: entries }] : []
  })

/** The path an entry opens, with its Settings section filled in. */
const navPath = (item: NavItem): string => (item.section ? `/settings/${item.section}` : item.to)

/** Stable key of an entry, unique even when several entries share a route (the Settings sections). */
export const navKey = (item: NavItem): string => navPath(item)

/** Router link props that open an entry. */
export const navLink = (item: NavItem): LinkProps =>
  item.section ? { to: '/settings/$section', params: { section: item.section } } : { to: item.to }

const under = (pathname: string, path: string) =>
  path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`)

/**
 * The entry a page belongs to: the one whose path is the longest prefix of `pathname` (`/` only
 * matches itself). A single analysis record (`/analyses/$id`) belongs to the page of its kind, so
 * pass `analysisKind` once it is known; kinds without a page belong to Repositories. Pass `items`
 * (the principal's `visibleNav`) so an entry the principal cannot open is never picked.
 */
export const activeNav = (
  pathname: string,
  analysisKind?: string,
  items: readonly NavItem[] = navItems,
): NavItem | undefined => {
  if (pathname.startsWith('/analyses/')) {
    if (analysisKind === undefined) return undefined
    const to = [...analysisPages, stackRecords].find((p) => p.kind === analysisKind)?.to ?? '/repos'
    return items.find((item) => item.to === to)
  }
  const matches = items.filter((item) => under(pathname, navPath(item)))
  const longest = Math.max(-1, ...matches.map((item) => navPath(item).length))
  return matches.find((item) => navPath(item).length === longest)
}

/** The public Holtkeeper documentation site. */
export const docsUrl = 'https://holtkeeper.github.io'

const workspaceGuides: Record<string, string> = {
  home: 'home/overview',
  repos: 'repos/repositories',
  chat: 'chat/threads',
  supply: 'supply-chain/libraries',
  quality: 'quality/coverage',
  releases: 'releases/overview',
  knowledge: 'knowledge/guide',
  ops: 'ops/runs',
  settings: 'settings/people',
}

/** The guide page of a workspace on the documentation site, or the guide's start without one. */
export const docsLinkFor = (workspace: string | undefined): string => {
  const page = workspace ? workspaceGuides[workspace] : undefined
  return page ? `${docsUrl}/guide/${page}/` : `${docsUrl}/guide/`
}
