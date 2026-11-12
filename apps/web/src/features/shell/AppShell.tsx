import { Link, Outlet, useMatch, useRouterState } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { type ComponentType, type ReactNode, useEffect, useMemo, useState } from 'react'

import {
  useAnalysis,
  useChatUnread,
  useInboxCount,
  useTaskApprovalCount,
} from '../../api/queries.ts'
import { unreadBadge } from '../../lib/chat.ts'
import { isPaletteShortcut } from '../../lib/palette.ts'
import { taskApprovalBadge } from '../../lib/tasks.ts'
import { Avatar, BrandIcon, Count, brandIconUrl } from '../../ui/index.ts'
import { ShellContext, type ShellSlots } from '../../ui/shell.ts'
import { CommandPalette } from './CommandPalette.tsx'
import {
  type NavBadge,
  type NavItem,
  activeNav,
  groupByWorkspace,
  navBadgeWord,
  navKey,
  navLink,
  visibleNav,
} from './nav.ts'
import { openPalette, setPaletteOpen, usePaletteOpen } from './palette.ts'
import { useSession } from './session.ts'

const appName = 'Holtkeeper'
const defaultFavicon = '/favicon.svg'

function useActiveNav(items: readonly NavItem[]): NavItem | undefined {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const record = useMatch({ from: '/app/analyses/$id', shouldThrow: false })
  const analysis = useAnalysis(
    record?.params.id ?? '',
    record?.search.compare,
    record !== undefined,
  )
  return activeNav(pathname, record ? analysis.data?.analysis.kind : undefined, items)
}

function setDocumentMeta(title: string, favicon: string) {
  document.title = title
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (icon) icon.href = favicon
}

function useDocumentMeta(item: NavItem | undefined) {
  useEffect(() => {
    setDocumentMeta(
      item ? `${item.label} · ${appName}` : appName,
      item?.brand ? brandIconUrl(item.brand) : defaultFavicon,
    )
    return () => setDocumentMeta(appName, defaultFavicon)
  }, [item])
}

function usePaletteShortcut() {
  const open = usePaletteOpen()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event) || event.isComposing) return
      event.preventDefault()
      setPaletteOpen(!open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
}

const railItemClass = (current: boolean) =>
  `relative flex h-[46px] w-14 shrink-0 flex-col items-center justify-center gap-[3px] rounded-[10px] transition-colors focus-visible:outline-2 focus-visible:outline-focus ${
    current
      ? 'bg-panel text-foreground shadow-[inset_0_0_0_1px_var(--line-strong)]'
      : 'text-muted hover:bg-raise hover:text-foreground'
  }`

function RailLabel({
  icon: Icon,
  label,
}: {
  icon: ComponentType<{ className?: string }>
  label: ReactNode
}) {
  return (
    <>
      <Icon className="size-[18px]" />
      <span aria-hidden className="text-[10px] leading-none font-medium tracking-[0.01em]">
        {label}
      </span>
    </>
  )
}

/**
 * The signed-in layout: a 60px rail of labelled workspaces with ⌘K, Settings and the account at
 * the bottom (a top strip on narrow screens), unread chat and open Inbox decisions as badges (and
 * task groups waiting for approval on the Tasks tab), the routed page in the main card, and the
 * side-sheet slot beside it. ⌘K or Ctrl+K opens the command palette from any page. Pages get the
 * workspace tabs and the slot through `ShellContext`.
 */
export function AppShell() {
  const { principal, crossTeam } = useSession()
  const visible = useMemo(() => visibleNav(principal, crossTeam), [principal, crossTeam])
  const groups = useMemo(() => groupByWorkspace(visible), [visible])
  const active = useActiveNav(visible)
  const current = groups.find((group) => group.workspace.id === active?.workspace)
  const settings = groups.find((group) => group.workspace.bottom)
  const unread = useChatUnread(groups.some((group) => group.workspace.id === 'chat'))
  const chatBadge = unreadBadge(unread.data?.total ?? 0)
  const inbox = useInboxCount(groups.some((group) => group.workspace.id === 'home'))
  const inboxBadge = unreadBadge(inbox.data?.total ?? 0)
  const approvals = useTaskApprovalCount(visible.some((item) => item.badge === 'tasks'))
  const tasksBadge = taskApprovalBadge(approvals.data?.count)
  const onAccount = useRouterState({
    select: (state) => /^\/account(\/|$)/.test(state.location.pathname),
  })
  const [sheet, setSheet] = useState<HTMLElement | null>(null)
  useDocumentMeta(active)
  usePaletteShortcut()

  const slots = useMemo<ShellSlots>(() => {
    const badges: Record<NavBadge, string> = { inbox: inboxBadge, tasks: tasksBadge }
    return {
      sheet,
      ...(current
        ? {
            workspace: {
              label: `${current.workspace.label} pages`,
              title: current.workspace.title ?? current.workspace.label,
              crumb: {
                label: current.workspace.title ?? current.workspace.label,
                link: navLink(current.items[0]!),
              },
              items: current.items.map((item) => ({
                id: navKey(item),
                label:
                  item.badge && badges[item.badge] ? (
                    <>
                      {item.label}
                      <Count label={`${badges[item.badge]} ${navBadgeWord[item.badge]}`}>
                        {badges[item.badge]}
                      </Count>
                    </>
                  ) : (
                    item.label
                  ),
                link: navLink(item),
              })),
              ...(active ? { selected: navKey(active) } : {}),
            },
          }
        : {}),
    }
  }, [sheet, current, active, inboxBadge, tasksBadge])

  return (
    <ShellContext value={slots}>
      <div className="shell">
        <a
          href="#main"
          className="sr-only z-50 rounded-lg bg-panel px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
        >
          Skip to content
        </a>
        <aside className="shell-rail">
          <Link
            to="/"
            aria-label={`${appName} home`}
            className="grid size-8 shrink-0 place-items-center rounded-[9px] focus-visible:outline-2 focus-visible:outline-focus"
          >
            <BrandIcon name="holtkeeper" className="size-7" />
          </Link>
          <nav aria-label="Workspaces" className="shell-rail-group">
            {groups
              .filter(({ workspace }) => !workspace.bottom)
              .map(({ workspace, items }) => {
                const selected = workspace.id === current?.workspace.id
                const badge =
                  workspace.id === 'chat'
                    ? chatBadge
                    : workspace.id === 'home'
                      ? inboxBadge
                      : undefined
                const badgeWord = workspace.id === 'chat' ? 'unread' : 'waiting in Inbox'
                return (
                  <Link
                    key={workspace.id}
                    {...navLink(items[0]!)}
                    aria-label={
                      badge ? `${workspace.label}, ${badge} ${badgeWord}` : workspace.label
                    }
                    aria-current={selected ? 'page' : undefined}
                    className={railItemClass(selected)}
                  >
                    <RailLabel icon={workspace.icon} label={workspace.label} />
                    {badge ? (
                      <span
                        aria-hidden
                        className="mono absolute top-0.5 right-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-semibold text-accent-foreground"
                      >
                        {badge}
                      </span>
                    ) : null}
                  </Link>
                )
              })}
          </nav>
          <div className="shell-rail-group shell-rail-bottom">
            <button
              type="button"
              aria-label="Search, Command K"
              onClick={openPalette}
              className={railItemClass(false)}
            >
              <RailLabel icon={Search} label="⌘K" />
            </button>
            {settings ? (
              <Link
                {...navLink(settings.items[0]!)}
                aria-label={settings.workspace.label}
                aria-current={current === settings ? 'page' : undefined}
                className={railItemClass(current === settings)}
              >
                <RailLabel icon={settings.workspace.icon} label={settings.workspace.label} />
              </Link>
            ) : null}
            <Link
              to="/account/$section"
              params={{ section: 'profile' }}
              aria-label={`Account: ${principal.name}`}
              aria-current={onAccount ? 'page' : undefined}
              className={`grid size-10 shrink-0 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-focus ${
                onAccount ? 'shadow-[inset_0_0_0_1px_var(--line-strong)]' : ''
              }`}
            >
              <Avatar key={principal.avatarUrl} src={principal.avatarUrl} name={principal.name} />
            </Link>
          </div>
        </aside>
        <main id="main" tabIndex={-1} className="shell-main">
          <Outlet />
        </main>
        <div ref={setSheet} className="shell-sheet" />
      </div>
      <CommandPalette />
    </ShellContext>
  )
}
