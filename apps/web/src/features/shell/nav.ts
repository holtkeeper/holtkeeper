import type { Action, AuthInfo, Principal } from '@holtkeeper/api'
import {
  Activity,
  BookOpen,
  Boxes,
  CalendarClock,
  DatabaseZap,
  FileSearch,
  Flame,
  FlaskConical,
  FolderGit2,
  GitBranch,
  Gauge,
  HardDrive,
  Images,
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
import { analysisPages, groupAnalysisPages } from '../../lib/analyses.ts'
import type { BrandIconName } from '../../ui/BrandIcon.tsx'

/** Sidebar headings in display order. */
const navSections = ['Overview', 'Security', 'Code', 'Delivery', 'Agents', 'Admin'] as const

export type NavSection = (typeof navSections)[number]

export interface NavItem {
  to:
    | '/'
    | '/repos'
    | '/audits'
    | '/releases'
    | '/bundles'
    | '/assets'
    | '/dependencies'
    | '/quality'
    | '/coverage'
    | '/testids'
    | '/branches'
    | '/ci'
    | '/warmup'
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
    | '/caches'
    | '/users'
    | '/audit-log'
    | '/activity'
  /** Sidebar heading the entry is listed under. */
  section: NavSection
  label: string
  icon: LucideIcon
  /** Brand icon used as the favicon while the entry is active. */
  brand?: BrandIconName
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
    brand: 'repos',
    label: 'Repositories',
    icon: FolderGit2,
    requires: 'repos:read',
  },
  {
    section: 'Overview',
    to: '/fleet',
    brand: 'fleet',
    label: 'Fleet',
    icon: Ship,
    requires: 'analyses:read',
  },
  {
    section: 'Overview',
    to: '/stack',
    brand: 'stack',
    label: 'Tech stack',
    icon: Layers,
    requires: 'analyses:read',
  },
  {
    section: 'Overview',
    to: '/activity',
    brand: 'activity',
    label: 'Activity',
    icon: Activity,
  },
  {
    section: 'Security',
    to: '/audits',
    brand: 'audit',
    label: 'Audits',
    icon: FileSearch,
    requires: 'audits:read',
  },
  {
    section: 'Security',
    to: '/licenses',
    brand: 'licenses',
    label: 'Licenses',
    icon: Scale,
    requires: 'analyses:read',
  },
  {
    section: 'Code',
    to: '/quality',
    brand: 'quality',
    label: 'Code quality',
    icon: Gauge,
    requires: 'analyses:read',
  },
  {
    section: 'Code',
    to: '/coverage',
    brand: 'coverage',
    label: 'Test coverage',
    icon: FlaskConical,
    requires: 'analyses:read',
  },
  {
    section: 'Code',
    to: '/testids',
    brand: 'testids',
    label: 'Test ids',
    icon: MousePointerClick,
    requires: 'analyses:read',
  },
  {
    section: 'Code',
    to: '/dependencies',
    brand: 'updates',
    label: 'Dependencies',
    icon: Network,
    requires: 'analyses:read',
  },
  {
    section: 'Code',
    to: '/bundles',
    brand: 'bundles',
    label: 'Bundles',
    icon: Boxes,
    requires: 'analyses:read',
  },
  {
    section: 'Code',
    to: '/assets',
    brand: 'assets',
    label: 'Assets',
    icon: Images,
    requires: 'analyses:read',
  },
  {
    section: 'Code',
    to: '/public-api',
    brand: 'api',
    label: 'Public API',
    icon: Library,
    requires: 'analyses:read',
  },
  {
    section: 'Delivery',
    to: '/releases',
    brand: 'release',
    label: 'Releases',
    icon: Tag,
    requires: 'analyses:read',
  },
  {
    section: 'Delivery',
    to: '/branches',
    brand: 'branches',
    label: 'Branches',
    icon: GitBranch,
    requires: 'analyses:read',
  },
  {
    section: 'Delivery',
    to: '/ci',
    brand: 'ci',
    label: 'CI jobs',
    icon: Timer,
    requires: 'analyses:read',
  },
  {
    section: 'Delivery',
    to: '/warmup',
    brand: 'warmup',
    label: 'Build warm-up',
    icon: Flame,
    requires: 'analyses:read',
  },
  {
    section: 'Agents',
    to: '/knowledge',
    brand: 'knowledge',
    label: 'Knowledge',
    icon: BookOpen,
    requires: 'knowledge:read',
  },
  {
    section: 'Agents',
    to: '/automation',
    brand: 'automation',
    label: 'Automation',
    icon: CalendarClock,
    requires: 'settings:read',
  },
  {
    section: 'Agents',
    to: '/jobs',
    brand: 'jobs',
    label: 'Jobs',
    icon: ListChecks,
    requires: 'analyses:read',
  },
  {
    section: 'Agents',
    to: '/ai',
    brand: 'ai',
    label: 'AI usage',
    icon: Sparkles,
    requires: 'ai:read',
  },
  {
    section: 'Admin',
    to: '/credentials',
    brand: 'credentials',
    label: 'Credentials',
    icon: KeyRound,
    requires: 'credentials:read',
  },
  {
    section: 'Admin',
    to: '/settings',
    brand: 'settings',
    label: 'Settings',
    icon: Settings2,
    requires: 'settings:read',
  },
  {
    section: 'Admin',
    to: '/storage',
    brand: 'storage',
    label: 'Storage',
    icon: HardDrive,
    requires: 'settings:read',
  },
  {
    section: 'Admin',
    to: '/caches',
    label: 'Caches',
    icon: DatabaseZap,
    requires: 'settings:read',
  },
  {
    section: 'Admin',
    to: '/users',
    brand: 'users',
    label: 'Users',
    icon: Users,
    requires: 'users:read',
    usersOnly: true,
  },
  {
    section: 'Admin',
    to: '/audit-log',
    brand: 'auditlog',
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

const analysisPrefix = '/analyses/'

/**
 * The entry a page belongs to: the one whose path is `pathname` or a parent of it. A single
 * analysis record (`/analyses/$id`) belongs to the page of its kind, so pass `analysisKind`
 * once the record is known.
 */
export const activeNav = (pathname: string, analysisKind?: string): NavItem | undefined => {
  if (pathname.startsWith(analysisPrefix)) {
    const page = [...analysisPages, ...groupAnalysisPages].find((p) => p.kind === analysisKind)
    return page && navItems.find((item) => item.to === page.to)
  }
  return navItems.find(
    (item) => pathname === item.to || (item.to !== '/' && pathname.startsWith(`${item.to}/`)),
  )
}

/** `items` grouped under their sidebar headings in display order; empty headings are left out. */
export const groupNav = (items: readonly NavItem[]): { section: NavSection; items: NavItem[] }[] =>
  navSections.flatMap((section) => {
    const entries = items.filter((item) => item.section === section)
    return entries.length ? [{ section, items: entries }] : []
  })

/** The public Holtkeeper documentation site. */
export const docsUrl = 'https://holtkeeper.github.io'
