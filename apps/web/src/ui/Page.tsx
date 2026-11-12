import { type LinkProps, useLocation } from '@tanstack/react-router'
import { SlidersHorizontal } from 'lucide-react'
import { type ComponentType, type ReactNode, useRef } from 'react'

import type { ScopeCounts, ScopeView } from '../lib/home-scope.ts'
import { currentTab } from '../lib/page-header.ts'
import { Button, LinkButton } from './Button.tsx'
import { type Crumb, Crumbs } from './Crumbs.tsx'
import { Kbd, SearchInput } from './Misc.tsx'
import { type MoreMenuItem, MoreMenu } from './MoreMenu.tsx'
import { ChooseTeamsLink, ScopeSwitch } from './ScopeSwitch.tsx'
import { SegmentedTabs } from './SegmentedTabs.tsx'
import { useShell } from './shell.ts'
import { useSlashFocus } from './useSlashFocus.ts'

/** A tab of the workspace a page belongs to; the current one is picked by the pathname. */
export interface PageTab {
  to: NonNullable<LinkProps['to']>
  label: ReactNode
}

/** A header button: navigates with `link`, otherwise calls `onPress`. */
export interface PageAction {
  label: ReactNode
  icon?: ComponentType<{ className?: string }>
  onPress?: () => void
  link?: LinkProps
  isDisabled?: boolean
}

const headerButton = (action: PageAction, variant: 'primary' | 'ghost') => {
  const content = (
    <>
      {action.icon ? <action.icon className="size-3.5" /> : null}
      {action.label}
    </>
  )
  return action.link && !action.isDisabled ? (
    <LinkButton {...action.link} variant={variant} size="sm">
      {content}
    </LinkButton>
  ) : (
    <Button
      variant={variant}
      size="sm"
      isDisabled={action.isDisabled === true}
      {...(action.onPress ? { onPress: action.onPress } : {})}
    >
      {content}
    </Button>
  )
}

function WorkspaceTabs({ tabs, label }: { tabs: readonly PageTab[]; label: string }) {
  const pathname = useLocation({ select: (location) => location.pathname })
  const current = currentTab(tabs, pathname)
  return (
    <SegmentedTabs
      aria-label={label}
      items={tabs.map((tab) => ({ id: tab.to, label: tab.label, link: { to: tab.to } }))}
      {...(current ? { selected: current.to } : {})}
    />
  )
}

function ShellTabs() {
  const { workspace } = useShell()
  if (!workspace || workspace.items.length < 2) return null
  return (
    <SegmentedTabs
      aria-label={workspace.label}
      items={workspace.items}
      {...(workspace.selected ? { selected: workspace.selected } : {})}
    />
  )
}

/**
 * The content of the shell's main card: a header with a breadcrumb trail (the current workspace's
 * crumb, then `crumbs`) and a title row, then the page body. The title row carries the tabs (`tabs`, else the current workspace's pages from
 * the shell), then on the right older free-form `actions`, a ghost "Configure", the "⋯" menu and
 * the one primary action. A toolbar row under it holds the scope switch, a search field that `/`
 * focuses, and filter buttons.
 */
export function Page({
  title,
  description,
  actions,
  crumbs,
  tabs,
  tabsLabel,
  scope,
  search,
  filters,
  more,
  primary,
  configure,
  children,
}: {
  /** Defaults to the current workspace's title. */
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** The trail above the title after the workspace's crumb; the last entry is this page. */
  crumbs?: readonly Crumb[]
  /**
   * Tabs next to the title; without them the current workspace's pages are shown, and `false`
   * shows none (pages with their own `SubNav`).
   */
  tabs?: readonly PageTab[] | false
  /** Accessible name of the tabs, e.g. "Repos sections". */
  tabsLabel?: string
  scope?: {
    value: ScopeView
    onChange: (view: ScopeView) => void
    counts?: ScopeCounts
  }
  /** A search field that `/` focuses; the hint shows `/` unless `hint` says otherwise. */
  search?: {
    value: string
    onChange: (value: string) => void
    'aria-label': string
    placeholder?: string
    hint?: string
  }
  /** Filter buttons after the search field, e.g. `FilterButton`s. */
  filters?: ReactNode
  /** Secondary actions, behind the "⋯" button. */
  more?: readonly MoreMenuItem[]
  /** The page's one primary action. */
  primary?: PageAction
  /** Where the page's analyzer options are set up; a ghost "Configure" button. */
  configure?: Omit<PageAction, 'label' | 'icon'>
  children: ReactNode
}) {
  const { workspace } = useShell()
  const trail = crumbs?.length && workspace ? [workspace.crumb, ...crumbs] : crumbs
  const searchRef = useRef<HTMLInputElement>(null)
  useSlashFocus(searchRef, Boolean(search))
  const hasTools = Boolean(actions || more?.length || primary || configure)
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-col gap-2.5 border-b border-line px-3.5 py-3">
        {trail?.length ? <Crumbs items={trail} /> : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="min-w-0 truncate text-[14px] font-semibold leading-tight">
              {title ?? workspace?.title}
            </h1>
            {tabs === false ? null : tabs?.length ? (
              <WorkspaceTabs tabs={tabs} label={tabsLabel ?? 'Sections'} />
            ) : (
              <ShellTabs />
            )}
          </div>
          {hasTools ? (
            <div className="flex flex-wrap items-center gap-2">
              {actions}
              {configure
                ? headerButton(
                    { ...configure, label: 'Configure', icon: SlidersHorizontal },
                    'ghost',
                  )
                : null}
              {more?.length ? <MoreMenu items={more} /> : null}
              {primary ? headerButton(primary, 'primary') : null}
            </div>
          ) : null}
        </div>
        {description ? <p className="-mt-1 text-sm text-muted">{description}</p> : null}
        {scope || search || filters ? (
          <div className="flex flex-wrap items-center gap-2">
            {scope ? (
              <ScopeSwitch
                value={scope.value}
                onChange={scope.onChange}
                teamsLink={false}
                {...(scope.counts ? { counts: scope.counts } : {})}
              />
            ) : null}
            {search ? (
              <div className="relative w-64 max-w-full">
                <SearchInput
                  aria-label={search['aria-label']}
                  value={search.value}
                  onChange={search.onChange}
                  inputRef={searchRef}
                  {...(search.placeholder ? { placeholder: search.placeholder } : {})}
                  className="w-full"
                />
                {search.value ? null : (
                  <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
                    <Kbd>{search.hint ?? '/'}</Kbd>
                  </span>
                )}
              </div>
            ) : null}
            {filters}
            {scope ? <ChooseTeamsLink /> : null}
          </div>
        ) : null}
      </header>
      <div className="flex flex-col gap-5 p-4">{children}</div>
    </div>
  )
}
