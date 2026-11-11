import { Link, type LinkProps, Outlet, useMatch, useRouterState } from '@tanstack/react-router'
import { BookText, LogOut } from 'lucide-react'
import { useEffect } from 'react'

import { messageOf } from '../../api/client.ts'
import { useAnalysis, useAuthMutations, useChatUnread } from '../../api/queries.ts'
import { unreadBadge } from '../../lib/chat.ts'
import {
  Avatar,
  BrandIcon,
  Button,
  SegmentedTabs,
  Tooltip,
  brandIconUrl,
  notify,
} from '../../ui/index.ts'
import { type NavItem, activeNav, docsUrl, groupByWorkspace, navKey, visibleNav } from './nav.ts'
import { useSession } from './session.ts'
import { ThemeToggle } from './ThemeToggle.tsx'

const appName = 'Holtkeeper'
const defaultFavicon = '/favicon.svg'

const linkOf = (item: NavItem): LinkProps =>
  item.tab ? { to: item.to, search: { tab: item.tab } } : { to: item.to }

function useActiveNav(items: readonly NavItem[]): NavItem | undefined {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const tab = useRouterState({
    select: (state) => {
      const value: unknown = (state.location.search as { tab?: unknown }).tab
      return typeof value === 'string' ? value : undefined
    },
  })
  const record = useMatch({ from: '/app/analyses/$id', shouldThrow: false })
  const analysis = useAnalysis(
    record?.params.id ?? '',
    record?.search.compare,
    record !== undefined,
  )
  return activeNav(pathname, record ? analysis.data?.analysis.kind : undefined, tab, items)
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

const railItemClass = (current: boolean) =>
  `grid size-9 place-items-center rounded-[10px] transition-colors focus-visible:outline-2 focus-visible:outline-focus ${
    current
      ? 'bg-panel text-foreground shadow-[inset_0_0_0_1px_var(--line-strong)]'
      : 'text-muted hover:bg-raise hover:text-foreground'
  }`

function Account() {
  const { principal, auth } = useSession()
  const { logout } = useAuthMutations()
  const avatar = (
    <Avatar key={principal.avatarUrl} src={principal.avatarUrl} name={principal.name} size="xs" />
  )
  return (
    <div className="flex flex-col items-center gap-1">
      <ThemeToggle />
      {auth.logoutUrl ? (
        <Tooltip content="Sign out">
          <Button
            variant="ghost"
            isIconOnly
            aria-label="Sign out"
            isPending={logout.isPending}
            onPress={() =>
              logout.mutate(auth.logoutUrl!, {
                onError: (error) => notify.error('Sign-out failed', messageOf(error)),
              })
            }
          >
            <LogOut className="size-4" />
          </Button>
        </Tooltip>
      ) : null}
      <Tooltip content={`${principal.name} · via ${principal.provider}`}>
        {auth.provider === 'users' ? (
          <Link to="/account" aria-label="Your account" className={railItemClass(false)}>
            {avatar}
          </Link>
        ) : (
          <span tabIndex={0} aria-label={principal.name} className={railItemClass(false)}>
            {avatar}
          </span>
        )}
      </Tooltip>
    </div>
  )
}

/** Workspace rail, the slim top bar with the workspace's tabs, and the routed page. */
export function AppShell() {
  const { principal, crossTeam } = useSession()
  const visible = visibleNav(principal, crossTeam)
  const groups = groupByWorkspace(visible)
  const active = useActiveNav(visible)
  const current = groups.find((group) => group.workspace.id === active?.workspace)
  const unread = useChatUnread(groups.some((group) => group.workspace.id === 'chat'))
  const chatBadge = unreadBadge(unread.data?.total ?? 0)
  useDocumentMeta(active)

  return (
    <div className="flex min-h-screen bg-background">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-panel px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 flex h-screen w-11 shrink-0 flex-col items-center gap-4 overflow-y-auto border-r border-line py-2">
        <Link
          to="/"
          aria-label={`${appName} home`}
          className="grid size-8 place-items-center rounded-[9px] focus-visible:outline-2 focus-visible:outline-focus"
        >
          <BrandIcon name="holtkeeper" className="size-7" />
        </Link>
        <nav aria-label="Workspaces" className="flex flex-col items-center gap-1">
          {groups.map(({ workspace, items }) => {
            const selected = workspace.id === current?.workspace.id
            return (
              <Tooltip key={workspace.id} content={workspace.label}>
                <Link
                  {...linkOf(items[0]!)}
                  aria-label={
                    workspace.id === 'chat' && chatBadge
                      ? `${workspace.label}, ${chatBadge} unread`
                      : workspace.label
                  }
                  aria-current={selected ? 'page' : undefined}
                  className={`relative ${railItemClass(selected)}`}
                >
                  <workspace.icon className="size-[18px]" />
                  {workspace.id === 'chat' && chatBadge ? (
                    <span
                      aria-hidden
                      className="mono absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[9px] leading-4 font-semibold text-accent-foreground"
                    >
                      {chatBadge}
                    </span>
                  ) : null}
                </Link>
              </Tooltip>
            )
          })}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-1">
          <Tooltip content="Documentation">
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Documentation"
              className={railItemClass(false)}
            >
              <BookText className="size-4" />
            </a>
          </Tooltip>
          <Account />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-11 shrink-0 items-center gap-3 border-b border-line bg-background px-4">
          <span className="shrink-0 text-[13px] font-semibold">
            {current?.workspace.label ?? appName}
          </span>
          {current && current.items.length > 1 ? (
            <SegmentedTabs
              aria-label={`${current.workspace.label} pages`}
              selected={active ? navKey(active) : undefined}
              items={current.items.map((item) => ({
                id: navKey(item),
                label: item.label,
                link: linkOf(item),
              }))}
            />
          ) : null}
        </header>
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-5 outline-none sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
