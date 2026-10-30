import type { Action, AuthInfo, Principal } from '@holtkeeper/api'
import {
  Activity,
  BookOpen,
  Boxes,
  CalendarClock,
  FileSearch,
  FlaskConical,
  FolderGit2,
  GitBranch,
  Gauge,
  HardDrive,
  KeyRound,
  Layers,
  LayoutDashboard,
  Library,
  ListChecks,
  type LucideIcon,
  MousePointerClick,
  Network,
  Scale,
  ScrollText,
  Settings2,
  Ship,
  Sparkles,
  Tag,
  Timer,
  Users,
} from 'lucide-react'

import { can } from '../../lib/access.ts'

/** Sidebar headings in display order. */
export const navSections = ['Overview', 'Security', 'Code', 'Delivery', 'Agents', 'Admin'] as const

export type NavSection = (typeof navSections)[number]

export interface NavItem {
  to:
    | '/'
    | '/repos'
    | '/audits'
    | '/releases'
    | '/bundles'
    | '/dependencies'
    | '/quality'
    | '/coverage'
    | '/testids'
    | '/branches'
    | '/ci'
    | '/licenses'
    | '/fleet'
    | '/stack'
    | '/public-api'
    | '/jobs'
    | '/knowledge'
    | '/credentials'
    | '/automation'
    | '/settings'
    | '/ai'
    | '/storage'
    | '/users'
    | '/audit-log'
    | '/activity'
  /** Sidebar heading the entry is listed under. */
  section: NavSection
  label: string
  icon: LucideIcon
  /** Hidden unless some grant allows this action. */
  requires?: Action
  /** Only for the `users` auth provider. */
  usersOnly?: boolean
}

const navItems: readonly NavItem[] = [
  {
    section: 'Overview',
    to: '/',
    label: 'Dashboard',
    icon: LayoutDashboard,
    requires: 'audits:read',
  },
  {
    section: 'Overview',
    to: '/repos',
    label: 'Repositories',
    icon: FolderGit2,
    requires: 'repos:read',
  },
  { section: 'Overview', to: '/fleet', label: 'Fleet', icon: Ship, requires: 'analyses:read' },
  {
    section: 'Overview',
    to: '/stack',
    label: 'Tech stack',
    icon: Layers,
    requires: 'analyses:read',
  },
  { section: 'Overview', to: '/activity', label: 'Activity', icon: Activity },
  {
    section: 'Security',
    to: '/audits',
    label: 'Audits',
    icon: FileSearch,
    requires: 'audits:read',
  },
  {
    section: 'Security',
    to: '/licenses',
    label: 'Licenses',
    icon: Scale,
    requires: 'analyses:read',
  },
  {
    section: 'Code',
    to: '/quality',
    label: 'Code quality',
    icon: Gauge,
    requires: 'analyses:read',
  },
  {
    section: 'Code',
    to: '/coverage',
    label: 'Test coverage',
    icon: FlaskConical,
    requires: 'analyses:read',
  },
  {
    section: 'Code',
    to: '/testids',
    label: 'Test ids',
    icon: MousePointerClick,
    requires: 'analyses:read',
  },
  {
    section: 'Code',
    to: '/dependencies',
    label: 'Dependencies',
    icon: Network,
    requires: 'analyses:read',
  },
  { section: 'Code', to: '/bundles', label: 'Bundles', icon: Boxes, requires: 'analyses:read' },
  {
    section: 'Code',
    to: '/public-api',
    label: 'Public API',
    icon: Library,
    requires: 'analyses:read',
  },
  { section: 'Delivery', to: '/releases', label: 'Releases', icon: Tag, requires: 'analyses:read' },
  {
    section: 'Delivery',
    to: '/branches',
    label: 'Branches',
    icon: GitBranch,
    requires: 'analyses:read',
  },
  { section: 'Delivery', to: '/ci', label: 'CI jobs', icon: Timer, requires: 'analyses:read' },
  {
    section: 'Agents',
    to: '/knowledge',
    label: 'Knowledge',
    icon: BookOpen,
    requires: 'knowledge:read',
  },
  {
    section: 'Agents',
    to: '/automation',
    label: 'Automation',
    icon: CalendarClock,
    requires: 'settings:read',
  },
  { section: 'Agents', to: '/jobs', label: 'Jobs', icon: ListChecks, requires: 'analyses:read' },
  { section: 'Agents', to: '/ai', label: 'AI usage', icon: Sparkles, requires: 'ai:read' },
  {
    section: 'Admin',
    to: '/credentials',
    label: 'Credentials',
    icon: KeyRound,
    requires: 'credentials:read',
  },
  {
    section: 'Admin',
    to: '/settings',
    label: 'Settings',
    icon: Settings2,
    requires: 'settings:read',
  },
  {
    section: 'Admin',
    to: '/storage',
    label: 'Storage',
    icon: HardDrive,
    requires: 'settings:read',
  },
  {
    section: 'Admin',
    to: '/users',
    label: 'Users',
    icon: Users,
    requires: 'users:read',
    usersOnly: true,
  },
  {
    section: 'Admin',
    to: '/audit-log',
    label: 'Audit log',
    icon: ScrollText,
    requires: 'audit:read',
  },
]

/** Navigation entries the principal can use under the given provider. */
export const visibleNav = (principal: Principal, auth: AuthInfo): NavItem[] =>
  navItems.filter(
    (item) =>
      (!item.requires || can(principal, item.requires)) &&
      (!item.usersOnly || auth.provider === 'users'),
  )

/** `items` grouped under their sidebar headings in display order; empty headings are left out. */
export const groupNav = (items: readonly NavItem[]): { section: NavSection; items: NavItem[] }[] =>
  navSections.flatMap((section) => {
    const entries = items.filter((item) => item.section === section)
    return entries.length ? [{ section, items: entries }] : []
  })

/** The public Holtkeeper documentation site. */
export const docsUrl = 'https://holtkeeper.github.io'
