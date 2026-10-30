import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { ArrowUpRight, BookText, LogOut, Menu, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useAuthMutations } from '../../api/queries.ts'
import { Avatar, BrandIcon, Button, Tooltip, notify } from '../../ui/index.ts'
import { docsUrl, groupNav, visibleNav } from './nav.ts'
import { useSession } from './session.ts'
import { ThemeToggle } from './ThemeToggle.tsx'

function Brand() {
  return (
    <Link
      to="/"
      className="flex items-center gap-2.5 rounded-lg px-2 py-1 focus-visible:outline-2 focus-visible:outline-focus"
    >
      <BrandIcon name="holtkeeper" className="size-8" />
      <span className="text-[15px] font-semibold tracking-tight">Holtkeeper</span>
    </Link>
  )
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { principal, auth } = useSession()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const groups = groupNav(visibleNav(principal, auth))
  return (
    <nav
      aria-label="Main"
      className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1"
    >
      {groups.map((group) => (
        <div key={group.section} className="flex flex-col gap-0.5">
          <h2 className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted/70">
            {group.section}
          </h2>
          {group.items.map((item) => {
            const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
            return (
              <Link
                key={item.to}
                to={item.to}
                {...(onNavigate ? { onClick: onNavigate } : {})}
                aria-current={active ? 'page' : undefined}
                className={`relative flex items-center gap-3 rounded-xl px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-focus ${
                  active
                    ? 'font-medium text-accent-soft-foreground'
                    : 'text-muted hover:bg-default-soft hover:text-foreground'
                }`}
              >
                {active ? (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-xl bg-accent-soft"
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                ) : null}
                <item.icon className="relative size-4" />
                <span className="relative">{item.label}</span>
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

function DocsLink() {
  return (
    <a
      href={docsUrl}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-xl px-3 py-1.5 text-sm text-muted transition-colors hover:bg-default-soft hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus"
    >
      <BookText className="size-4" />
      <span>Documentation</span>
      <ArrowUpRight className="ml-auto size-3.5 opacity-60" />
    </a>
  )
}

function Identity({ linked, children }: { linked: boolean; children: ReactNode }) {
  const className = 'flex items-center gap-2.5 rounded-xl py-1 pl-1 pr-2'
  if (!linked) return <div className={className}>{children}</div>
  return (
    <Link
      to="/account"
      aria-label="Your account"
      className={`${className} transition-colors hover:bg-default-soft focus-visible:outline-2 focus-visible:outline-focus`}
    >
      {children}
    </Link>
  )
}

function Account() {
  const { principal, auth } = useSession()
  const { logout } = useAuthMutations()
  return (
    <div className="flex items-center gap-2">
      <ThemeToggle />
      <Identity linked={auth.provider === 'users'}>
        <Avatar key={principal.avatarUrl} src={principal.avatarUrl} name={principal.name} />
        <div className="hidden leading-tight sm:block">
          <div className="max-w-40 truncate text-sm font-medium">{principal.name}</div>
          <div className="text-xs text-muted">via {principal.provider}</div>
        </div>
      </Identity>
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
    </div>
  )
}

/** Sidebar, header and the routed page of the signed-in app. */
export function AppShell() {
  const [drawer, setDrawer] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (drawer && event.key === 'Escape') setDrawer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer])

  return (
    <div className="app-backdrop flex min-h-screen">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-6 border-r border-separator px-3 py-4 lg:flex">
        <Brand />
        <Nav />
        <div className="flex flex-col gap-2">
          <DocsLink />
          <div className="px-3 text-xs text-muted">Keeps every repository in shape.</div>
        </div>
      </aside>

      <AnimatePresence>
        {drawer ? (
          <motion.div
            className="fixed inset-0 z-40 lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-backdrop"
              onClick={() => setDrawer(false)}
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', stiffness: 380, damping: 36 }}
              className="relative flex h-full w-64 flex-col gap-6 bg-overlay px-3 py-4 shadow-overlay"
            >
              <div className="flex items-center justify-between">
                <Brand />
                <Button
                  variant="ghost"
                  isIconOnly
                  aria-label="Close navigation"
                  onPress={() => setDrawer(false)}
                >
                  <X className="size-4" />
                </Button>
              </div>
              <Nav onNavigate={() => setDrawer(false)} />
              <DocsLink />
            </motion.aside>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-separator bg-background/75 px-4 backdrop-blur-md sm:px-6">
          <div className="flex items-center gap-2 lg:hidden">
            <Button
              variant="ghost"
              isIconOnly
              aria-label="Open navigation"
              onPress={() => setDrawer(true)}
            >
              <Menu className="size-4" />
            </Button>
            <Brand />
          </div>
          <div className="hidden lg:block" />
          <Account />
        </header>
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
