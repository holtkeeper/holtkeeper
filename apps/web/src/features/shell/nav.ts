import type { Action, AuthInfo, Principal } from '@holtkeeper/api'
import {
  Activity,
  BookOpen,
  Boxes,
  CalendarClock,
  FileSearch,
  FolderGit2,
  Gauge,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  Network,
  Scale,
  ScrollText,
  Settings2,
  Sparkles,
  Tag,
  Timer,
  Users,
} from 'lucide-react'

import { can } from '../../lib/access.ts'

export interface NavItem {
  to:
    | '/'
    | '/repos'
    | '/audits'
    | '/releases'
    | '/bundles'
    | '/dependencies'
    | '/quality'
    | '/ci'
    | '/licenses'
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
  label: string
  icon: LucideIcon
  /** Hidden unless some grant allows this action. */
  requires?: Action
  /** Only for the `users` auth provider. */
  usersOnly?: boolean
}

const navItems: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, requires: 'audits:read' },
  { to: '/repos', label: 'Repositories', icon: FolderGit2, requires: 'repos:read' },
  { to: '/audits', label: 'Audits', icon: FileSearch, requires: 'audits:read' },
  { to: '/releases', label: 'Releases', icon: Tag, requires: 'analyses:read' },
  { to: '/bundles', label: 'Bundles', icon: Boxes, requires: 'analyses:read' },
  { to: '/dependencies', label: 'Dependencies', icon: Network, requires: 'analyses:read' },
  { to: '/quality', label: 'Code quality', icon: Gauge, requires: 'analyses:read' },
  { to: '/ci', label: 'CI jobs', icon: Timer, requires: 'analyses:read' },
  { to: '/licenses', label: 'Licenses', icon: Scale, requires: 'analyses:read' },
  { to: '/jobs', label: 'Jobs', icon: ListChecks, requires: 'analyses:read' },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen, requires: 'knowledge:read' },
  { to: '/credentials', label: 'Credentials', icon: KeyRound, requires: 'credentials:read' },
  { to: '/automation', label: 'Automation', icon: CalendarClock, requires: 'settings:read' },
  { to: '/settings', label: 'Settings', icon: Settings2, requires: 'settings:read' },
  { to: '/ai', label: 'AI usage', icon: Sparkles, requires: 'ai:read' },
  { to: '/storage', label: 'Storage', icon: HardDrive, requires: 'settings:read' },
  { to: '/users', label: 'Users', icon: Users, requires: 'users:read', usersOnly: true },
  { to: '/audit-log', label: 'Audit log', icon: ScrollText, requires: 'audit:read' },
  { to: '/activity', label: 'Activity', icon: Activity },
]

/** Navigation entries the principal can use under the given provider. */
export const visibleNav = (principal: Principal, auth: AuthInfo): NavItem[] =>
  navItems.filter(
    (item) =>
      (!item.requires || can(principal, item.requires)) &&
      (!item.usersOnly || auth.provider === 'users'),
  )
