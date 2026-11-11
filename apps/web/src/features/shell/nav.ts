import type { Action, CrossTeamLevel, Principal } from '@holtkeeper/api'
import {
  BookOpen,
  Bot,
  Boxes,
  CodeXml,
  FileSearch,
  FlaskConical,
  FolderGit2,
  GitBranch,
  History,
  HardDrive,
  Layers,
  LayoutDashboard,
  Library,
  ListChecks,
  type LucideIcon,
  MessagesSquare,
  Network,
  Plug,
  Rocket,
  Scale,
  Settings2,
  Sparkles,
  Timer,
  Users,
  Workflow,
} from 'lucide-react'

import { can, canCatalog, canGlobal } from '../../lib/access.ts'
import { analysisPages, stackRecords } from '../../lib/analyses.ts'
import { type SettingsTabId, parseSettingsTab, settingsTabs } from '../../lib/settings-tabs.ts'
import type { BrandIconName } from '../../ui/BrandIcon.tsx'

/** A rail entry: a group of pages that share the segmented tabs of the top bar. */
export interface Workspace {
  id: 'home' | 'repos' | 'chat' | 'code' | 'delivery' | 'team' | 'ops' | 'admin'
  label: string
  icon: LucideIcon
}

/** Rail entries in display order. */
const workspaces: readonly Workspace[] = [
  { id: 'home', label: 'Home', icon: LayoutDashboard },
  { id: 'repos', label: 'Repositories', icon: FolderGit2 },
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'code', label: 'Code', icon: CodeXml },
  { id: 'delivery', label: 'Delivery', icon: Rocket },
  { id: 'team', label: 'Team', icon: BookOpen },
  { id: 'ops', label: 'Ops', icon: Workflow },
  { id: 'admin', label: 'Admin', icon: Settings2 },
]

/** A page reachable from the shell, shown as a tab of its workspace. */
export interface NavItem {
  to:
    | '/'
    | '/repos'
    | '/audits'
    | '/releases'
    | '/bundles'
    | '/dependencies'
    | '/coverage'
    | '/branches'
    | '/ci'
    | '/licenses'
    | '/stack'
    | '/public-api'
    | '/jobs'
    | '/tasks'
    | '/knowledge'
    | '/automation'
    | '/settings'
    | '/history'
    | '/chat'
  /** The page's `tab` search parameter, for entries that open one tab of a shared page. */
  tab?: string
  workspace: Workspace['id']
  label: string
  icon: LucideIcon
  /** Brand icon used as the favicon while the entry is active. */
  brand?: BrandIconName
  /** Hidden unless some grant allows this action, or one of these actions. */
  requires?: Action | readonly Action[]
  /** `requires` must come from a grant over everything, because the server checks it globally. */
  global?: boolean
  /** Catalog reach is enough (`canCatalog`), like the server's catalog check; replaces `requires`. */
  catalog?: boolean
}

const navItems: readonly NavItem[] = [
  { workspace: 'home', to: '/', label: 'Home', icon: LayoutDashboard },
  {
    workspace: 'repos',
    to: '/repos',
    brand: 'repos',
    label: 'Repositories',
    icon: FolderGit2,
    requires: 'repos:read',
  },
  {
    workspace: 'chat',
    to: '/chat',
    brand: 'chat',
    label: 'Chat',
    icon: MessagesSquare,
    requires: 'repos:read',
  },
  {
    workspace: 'code',
    to: '/dependencies',
    brand: 'updates',
    label: 'Dependencies',
    icon: Network,
    catalog: true,
  },
  {
    workspace: 'code',
    to: '/public-api',
    brand: 'api',
    label: 'Public API',
    icon: Library,
    catalog: true,
  },
  {
    workspace: 'code',
    to: '/stack',
    brand: 'stack',
    label: 'Stack',
    icon: Layers,
    catalog: true,
  },
  {
    workspace: 'code',
    to: '/audits',
    brand: 'audit',
    label: 'Audits',
    icon: FileSearch,
    requires: 'audits:read',
  },
  {
    workspace: 'code',
    to: '/licenses',
    brand: 'licenses',
    label: 'Licenses',
    icon: Scale,
    requires: 'analyses:read',
  },
  {
    workspace: 'code',
    to: '/bundles',
    brand: 'bundles',
    label: 'Bundles',
    icon: Boxes,
    requires: 'analyses:read',
  },
  {
    workspace: 'code',
    to: '/coverage',
    brand: 'coverage',
    label: 'Coverage',
    icon: FlaskConical,
    requires: 'analyses:read',
  },
  {
    workspace: 'code',
    to: '/branches',
    brand: 'branches',
    label: 'Branches',
    icon: GitBranch,
    requires: 'analyses:read',
  },
  {
    workspace: 'delivery',
    to: '/releases',
    brand: 'releaseboard',
    label: 'Releases',
    icon: Rocket,
    requires: 'releases:read',
  },
  {
    workspace: 'delivery',
    to: '/ci',
    brand: 'ci',
    label: 'CI',
    icon: Timer,
    requires: 'analyses:read',
  },
  {
    workspace: 'team',
    to: '/knowledge',
    brand: 'knowledge',
    label: 'Knowledge',
    icon: BookOpen,
    requires: 'knowledge:read',
  },
  {
    workspace: 'ops',
    to: '/automation',
    global: true,
    brand: 'automation',
    label: 'Automation',
    icon: Workflow,
    requires: 'settings:read',
  },
  {
    workspace: 'ops',
    to: '/jobs',
    brand: 'jobs',
    label: 'Jobs',
    icon: ListChecks,
    requires: 'analyses:read',
  },
  {
    workspace: 'ops',
    to: '/tasks',
    brand: 'jobs',
    label: 'Tasks',
    icon: Bot,
    requires: 'repos:read',
  },
  {
    workspace: 'ops',
    to: '/history',
    brand: 'auditlog',
    label: 'History',
    icon: History,
    requires: 'repos:read',
  },
  {
    workspace: 'admin',
    to: '/settings',
    tab: 'ai',
    brand: 'ai',
    label: settingsTabs.ai.label,
    icon: Sparkles,
    requires: ['ai:read', 'ai:admin', 'settings:read', 'credentials:read'],
  },
  {
    workspace: 'admin',
    to: '/settings',
    tab: 'access',
    brand: 'users',
    label: settingsTabs.access.label,
    icon: Users,
  },
  {
    workspace: 'admin',
    to: '/settings',
    tab: 'integrations',
    brand: 'credentials',
    label: settingsTabs.integrations.label,
    icon: Plug,
    requires: ['credentials:read', 'settings:read'],
  },
  {
    workspace: 'admin',
    to: '/settings',
    tab: 'system',
    global: true,
    brand: 'storage',
    label: settingsTabs.system.label,
    icon: HardDrive,
    requires: 'settings:read',
  },
]

const allowed = (item: NavItem, principal: Principal, crossTeam: CrossTeamLevel) => {
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

/** The Settings tabs the principal can open, in display order. */
export const visibleSettingsTabs = (principal: Principal): SettingsTabId[] =>
  visibleNav(principal, 'off').flatMap((item) => {
    const tab = item.to === '/settings' ? parseSettingsTab(item.tab) : undefined
    return tab ? [tab] : []
  })

/** `items` grouped under their workspaces in rail order; workspaces left without items are dropped. */
export const groupByWorkspace = (
  items: readonly NavItem[],
): { workspace: Workspace; items: NavItem[] }[] =>
  workspaces.flatMap((workspace) => {
    const entries = items.filter((item) => item.workspace === workspace.id)
    return entries.length ? [{ workspace, items: entries }] : []
  })

/** Stable key of an entry, unique even when several entries open tabs of one page. */
export const navKey = (item: NavItem): string => (item.tab ? `${item.to}?tab=${item.tab}` : item.to)

const analysisPrefix = '/analyses/'

const pick = (candidates: readonly NavItem[], tab: string | undefined): NavItem | undefined =>
  candidates.find((item) => item.tab !== undefined && item.tab === tab) ??
  candidates.find((item) => item.tab === undefined) ??
  candidates[0]

/**
 * The entry a page belongs to: the one whose path is `pathname` or a parent of it. When several
 * entries open tabs of one page, `tab` (the page's `tab` search parameter) picks among them,
 * falling back to the entry without a tab, then to the first. A single analysis record
 * (`/analyses/$id`) belongs to the page of its kind, so pass `analysisKind` once it is known;
 * kinds without a page belong to Repositories, whose repository page shows them. Pass `items`
 * (the principal's `visibleNav`) so a tab the principal cannot open is never picked.
 */
export const activeNav = (
  pathname: string,
  analysisKind?: string,
  tab?: string,
  items: readonly NavItem[] = navItems,
): NavItem | undefined => {
  if (pathname.startsWith(analysisPrefix)) {
    if (analysisKind === undefined) return undefined
    const to = [...analysisPages, stackRecords].find((p) => p.kind === analysisKind)?.to ?? '/repos'
    return pick(
      items.filter((item) => item.to === to),
      undefined,
    )
  }
  return pick(
    items.filter(
      (item) => pathname === item.to || (item.to !== '/' && pathname.startsWith(`${item.to}/`)),
    ),
    tab,
  )
}

/** The public Holtkeeper documentation site. */
export const docsUrl = 'https://holtkeeper.github.io'
