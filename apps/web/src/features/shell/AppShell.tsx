import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { LogOut, Menu, ShieldCheck, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useAuthMutations } from '../../api/queries.ts'
import { Button, Tooltip, notify } from '../../ui/index.ts'
import { visibleNav } from './nav.ts'
import { useSession } from './session.ts'
import { ThemeToggle } from './ThemeToggle.tsx'

function Brand() {
  return (
    <Link
      to="/"
      className="flex items-center gap-2.5 rounded-lg px-2 py-1 focus-visible:outline-2 focus-visible:outline-focus"
    >
      <span className="grid size-8 place-items-center rounded-xl bg-accent text-accent-foreground shadow-surface">
        <ShieldCheck className="size-4.5" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight">Holtkeeper</span>
    </Link>
  )
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { principal, auth } = useSession()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const items = visibleNav(principal, auth)
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
        return (
          <Link
            key={item.to}
            to={item.to}
            {...(onNavigate ? { onClick: onNavigate } : {})}
            aria-current={active ? 'page' : undefined}
            className={`relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-focus ${
              active
                ? 'font-medium text-foreground'
                : 'text-muted hover:bg-default-soft hover:text-foreground'
            }`}
          >
            {active ? (
              <motion.span
                layoutId="nav-active"
                className="absolute inset-0 rounded-xl bg-surface shadow-surface"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            ) : null}
            <item.icon className="relative size-4" />
            <span className="relative">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

function Account() {
  const { principal, auth } = useSession()
  const { logout } = useAuthMutations()
  const initials = principal.name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <div className="flex items-center gap-2">
      <ThemeToggle />
      <div className="flex items-center gap-2.5 rounded-xl py-1 pl-1 pr-2">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-soft-foreground"
        >
          {initials || '?'}
        </span>
        <div className="hidden leading-tight sm:block">
          <div className="max-w-40 truncate text-sm font-medium">{principal.name}</div>
          <div className="text-xs text-muted">via {principal.provider}</div>
        </div>
      </div>
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
        <div className="mt-auto px-3 text-xs text-muted">
          Dependency security for every repository.
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
