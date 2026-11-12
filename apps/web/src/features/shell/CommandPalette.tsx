import { Modal } from '@heroui/react'
import type { Action } from '@holtkeeper/api'
import { Link, type NavigateOptions, useNavigate } from '@tanstack/react-router'
import {
  BookOpen,
  Clock,
  CornerDownLeft,
  FolderGit2,
  LogOut,
  type LucideIcon,
  MessageSquarePlus,
  Moon,
  Package,
  PanelsTopLeft,
  Search,
  SlidersHorizontal,
  Sun,
  User,
} from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useAuthMutations,
  useChatThreads,
  useDependencySearch,
  useGroupTitles,
  usePublicApiSearch,
  useRepos,
  useSettings,
  useUsers,
} from '../../api/queries.ts'
import { canCatalog, visibleSettingsSections } from '../../lib/access.ts'
import { formatRelative } from '../../lib/format.ts'
import { cellTones, healthCells } from '../../lib/home.ts'
import {
  type PaletteFilter,
  type PaletteItem,
  type PaletteKind,
  type PaletteRepoState,
  type PaletteTone,
  actionItems,
  browserStorage,
  buildResults,
  filterLabels,
  highlight,
  libraryItems,
  moveSelection,
  pageItems,
  paletteKinds,
  parseQuery,
  peopleItems,
  readRecent,
  recentItems,
  recordRecent,
  repoItems,
  settingItems,
  symbolItems,
  toneLabels,
} from '../../lib/palette.ts'
import { hubSearch, repoTabs, visibleTabs } from '../../lib/repo-page.ts'
import { isRepoHubTab, repoSplat } from '../../lib/repo.ts'
import { settingsIndex } from '../../lib/settings-search.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import type { StatusTone } from '../../ui/colors.ts'
import { Count, Dot, GroupName, notify, Tag, useTheme } from '../../ui/index.ts'
import { NewThreadDialog } from '../chat/ThreadList.tsx'
import { docsUrl, groupByWorkspace, navKey, navLink, paletteNav, visibleNav } from './nav.ts'
import { setPaletteOpen, usePaletteOpen } from './palette.ts'
import { useSession } from './session.ts'

const kindIcons: Record<PaletteItem['kind'], LucideIcon> = {
  repos: FolderGit2,
  libraries: Package,
  pages: PanelsTopLeft,
  settings: SlidersHorizontal,
  actions: CornerDownLeft,
  people: User,
}

const tagTones: Record<PaletteTone, StatusTone> = {
  danger: 'danger',
  warning: 'warning',
  ok: 'success',
  none: 'default',
}

const closePalette = () => setPaletteOpen(false)

const optionId = (index: number) => `palette-option-${index}`

function itemIcon(item: PaletteItem, theme: 'light' | 'dark'): LucideIcon {
  if (item.action === 'theme') return theme === 'dark' ? Sun : Moon
  if (item.action === 'docs') return BookOpen
  if (item.action === 'sign-out') return LogOut
  if (item.action === 'new-thread') return MessageSquarePlus
  return kindIcons[item.kind]
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const { pre, hit, post } = highlight(text, query)
  return (
    <>
      {pre}
      {hit ? (
        <mark className="rounded-[3px] bg-[color-mix(in_oklab,var(--brand)_26%,transparent)] px-px text-foreground">
          {hit}
        </mark>
      ) : null}
      {post}
    </>
  )
}

function Option({
  item,
  index,
  selected,
  query,
  recent,
  theme,
  onHover,
  onRun,
}: {
  item: PaletteItem
  index: number
  selected: boolean
  query: string
  recent: boolean
  theme: 'light' | 'dark'
  onHover: (index: number) => void
  onRun: (item: PaletteItem) => void
}) {
  const Icon = recent ? Clock : itemIcon(item, theme)
  const body: ReactNode = (
    <>
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-md border border-line bg-raise text-muted"
      >
        <Icon className="size-[13px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate font-medium ${item.mono ? 'mono' : ''}`}>
          <Highlighted text={item.title} query={query} />
        </span>
        {item.subtitle ? (
          <span className="truncate text-xs text-muted">{item.subtitle}</span>
        ) : null}
      </span>
      {item.meta ? (
        item.tone && !recent ? (
          <Tag tone={tagTones[item.tone]}>{item.meta}</Tag>
        ) : (
          <span className={`shrink-0 text-xs text-muted ${recent ? 'mono' : ''}`}>{item.meta}</span>
        )
      ) : null}
      <CornerDownLeft
        aria-hidden
        className={`size-3.5 shrink-0 text-muted ${selected ? '' : 'invisible'}`}
      />
    </>
  )
  const className = `flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-foreground no-underline ${
    selected ? 'bg-raise shadow-[inset_0_0_0_1px_var(--line-strong)]' : ''
  }`
  const common = {
    id: optionId(index),
    role: 'option',
    'aria-selected': selected,
    className,
    onMouseMove: () => {
      if (!selected) onHover(index)
    },
  } as const
  if (item.link)
    return (
      <Link
        {...item.link}
        {...common}
        tabIndex={-1}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
          event.preventDefault()
          onRun(item)
        }}
      >
        {body}
      </Link>
    )
  return (
    <button type="button" {...common} tabIndex={-1} onClick={() => onRun(item)}>
      {body}
    </button>
  )
}

function RepoPreview({
  repo,
  can,
  onOpen,
}: {
  repo: PaletteRepoState
  can: (action: Action) => boolean
  onOpen: () => void
}) {
  const tabs = visibleTabs(repoTabs, can)
  const cells = healthCells.flatMap(({ key, label }) => {
    const cell = repo.cells[key]
    return cell ? [{ key, label, cell }] : []
  })
  return (
    <aside
      aria-label={`Preview: ${repo.path}`}
      className="flex max-w-80 min-w-0 flex-[1_1_280px] flex-col gap-3 border-line bg-sunk p-3.5 max-[760px]:max-w-none max-[760px]:border-t min-[761px]:border-l"
    >
      <div className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md border border-line bg-raise text-muted">
          <FolderGit2 className="size-[13px]" aria-hidden />
        </span>
        <span className="mono truncate text-[13px] font-medium">{repo.path}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone={tagTones[repo.tone]}>{toneLabels[repo.tone]}</Tag>
        {repo.groups.map((group) => (
          <Tag key={group}>
            <GroupName group={group} />
          </Tag>
        ))}
        <span className="mono text-xs text-muted">{repo.forge}</span>
      </div>
      {cells.length ? (
        <dl className="m-0 grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-[7px] text-[12.5px]">
          {cells.map(({ key, label, cell }) => (
            <div key={key} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="m-0 flex min-w-0 items-center gap-1.5">
                <Dot tone={cellTones[cell.tone]} />
                <span className="truncate">{cell.value}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="m-0 text-xs text-muted">No health results yet.</p>
      )}
      {tabs.length ? (
        <>
          <span className="text-[11.5px] font-medium text-muted">Jump to</span>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {tabs.map((tab, index) => (
              <li key={tab.id}>
                <Link
                  to="/repos/$"
                  params={{ _splat: repoSplat(repo) }}
                  search={isRepoHubTab(tab.id) ? hubSearch(tab.id) : {}}
                  onClick={onOpen}
                  className="flex h-[30px] items-center gap-2 rounded-[7px] px-2 text-[12.5px] text-foreground no-underline hover:bg-raise"
                >
                  {tab.label}
                  {index === 0 ? (
                    <span className="mono ml-auto rounded border border-line-strong px-[5px] text-[11px] text-muted">
                      ↵
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </aside>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <span className="mono rounded border border-line-strong px-[5px] text-[11px] text-muted">
      {children}
    </span>
  )
}

function PaletteBody({ onClose, onNewThread }: { onClose: () => void; onNewThread: () => void }) {
  const { principal, auth, crossTeam, can } = useSession()
  const navigate = useNavigate()
  const { theme, setPreference } = useTheme()
  const { logout } = useAuthMutations()
  const [raw, setRaw] = useState('')
  const [chip, setChip] = useState<PaletteFilter>('all')
  const [index, setIndex] = useState(0)
  const [recent, setRecent] = useState(() => readRecent(browserStorage(), principal.id))

  const parsed = parseQuery(raw)
  const filter: PaletteFilter = parsed.kind ?? chip
  const debounced = useDebounced(parsed.text, 150)
  const catalog = canCatalog(principal, crossTeam)
  const canRepos = can('repos:read')
  const canPeople = can('users:read') && auth.provider === 'users'
  const wantsLibraries =
    catalog && debounced.length > 0 && (filter === 'all' || filter === 'libraries')

  const visible = useMemo(() => visibleNav(principal, crossTeam), [principal, crossTeam])
  const repos = useRepos(canRepos)
  const titleOf = useGroupTitles()
  const dependencies = useDependencySearch(wantsLibraries ? debounced : '')
  const symbols = usePublicApiSearch({
    q: wantsLibraries && debounced.length >= 2 ? debounced : '',
  })
  const settings = useSettings(can('settings:read'))
  const users = useUsers(canPeople)

  const sources = useMemo((): Partial<Record<PaletteKind, PaletteItem[]>> => {
    const reachable = {
      repos: repoItems(repos.data?.repos ?? [], titleOf),
      libraries: wantsLibraries
        ? [
            ...libraryItems(dependencies.data?.libraries ?? []),
            ...symbolItems(symbols.data?.hits ?? []),
          ]
        : [],
      pages: pageItems(
        groupByWorkspace(paletteNav(visible)).map(({ workspace, items }) => ({
          workspace,
          items: items.map((item) => ({
            label: item.label,
            key: navKey(item),
            link: navLink(item),
          })),
        })),
      ),
      settings: settingItems(
        settingsIndex(settings.data?.definitions ?? [], visibleSettingsSections(principal)),
      ),
      actions: actionItems({
        theme,
        signOut: auth.logoutUrl !== undefined,
        chat: visible.some((item) => item.to === '/chat'),
      }),
      people: peopleItems(users.data?.users ?? []),
    }
    return {
      ...reachable,
      recent: recentItems(recent, (at) => formatRelative(at), reachable, catalog),
    }
  }, [
    repos.data,
    titleOf,
    wantsLibraries,
    dependencies.data,
    symbols.data,
    visible,
    settings.data,
    principal,
    theme,
    auth.logoutUrl,
    users.data,
    recent,
    catalog,
  ])

  const results = useMemo(
    () => buildResults(sources, parsed.text, filter),
    [sources, parsed.text, filter],
  )
  const selected = results.flat[Math.min(index, results.flat.length - 1)]
  const selectedIndex = selected ? results.flat.indexOf(selected) : -1
  const searching =
    (wantsLibraries && (dependencies.isFetching || symbols.isFetching)) || debounced !== parsed.text

  useEffect(() => {
    if (selectedIndex >= 0)
      document.getElementById(optionId(selectedIndex))?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const chips = paletteKinds.filter(
    (kind) =>
      (kind !== 'repos' || canRepos) &&
      (kind !== 'libraries' || catalog) &&
      (kind !== 'people' || canPeople),
  )

  const run = (item: PaletteItem) => {
    if (item.link) {
      setRecent(recordRecent(browserStorage(), principal.id, item))
      onClose()
      void navigate(item.link as NavigateOptions)
      return
    }
    onClose()
    if (item.action === 'theme') setPreference(theme === 'dark' ? 'light' : 'dark')
    if (item.action === 'docs') window.open(docsUrl, '_blank', 'noopener,noreferrer')
    if (item.action === 'new-thread') onNewThread()
    if (item.action === 'sign-out' && auth.logoutUrl)
      logout.mutate(auth.logoutUrl, {
        onError: (error) => notify.error('Sign-out failed', messageOf(error)),
      })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex(
        moveSelection(selectedIndex, event.key === 'ArrowDown' ? 1 : -1, results.flat.length),
      )
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (selected) run(selected)
    }
  }

  let position = 0
  const total = results.flat.length

  return (
    <div className="flex max-h-[calc(100dvh-96px)] min-h-0 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-3.5">
        <Search aria-hidden className="size-4 text-muted" />
        <label htmlFor="palette-query" className="sr-only">
          Search Holtkeeper
        </label>
        <input
          id="palette-query"
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-autocomplete="list"
          {...(selected ? { 'aria-activedescendant': optionId(selectedIndex) } : {})}
          value={raw}
          onChange={(event) => {
            setRaw(event.target.value)
            setIndex(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Search repositories, libraries, pages, settings"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-dim"
        />
        <span aria-live="polite" className="text-xs text-muted">
          {searching
            ? 'Searching…'
            : parsed.text
              ? `${total} ${total === 1 ? 'result' : 'results'}`
              : ''}
        </span>
        <Kbd>esc</Kbd>
      </div>
      <div
        role="group"
        aria-label="Limit results to"
        className="flex shrink-0 flex-wrap gap-1.5 border-b border-line px-3 py-2"
      >
        {(['all', ...chips] as const).map((kind) => {
          const active = filter === kind
          const count =
            kind === 'all'
              ? undefined
              : kind === 'recent'
                ? results.counts.recent
                : parsed.text
                  ? results.counts[kind]
                  : undefined
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setChip(kind)
                setRaw(parsed.text)
                setIndex(0)
              }}
              className={`inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors ${
                active
                  ? 'border-line-strong bg-panel text-foreground shadow-[0_0_0_1px_var(--line-strong)]'
                  : 'border-line bg-raise text-muted hover:text-foreground'
              }`}
            >
              {filterLabels[kind]}
              {count !== undefined ? <Count>{count}</Count> : null}
            </button>
          )
        })}
      </div>
      <div className="flex min-h-0 flex-1 flex-wrap overflow-y-auto">
        <div
          id="palette-list"
          role="listbox"
          aria-label={parsed.text ? `Results for ${parsed.text}` : 'Suggestions'}
          className="flex min-w-0 flex-[999_1_420px] flex-col p-1.5"
        >
          {results.groups.map((group) => (
            <div key={group.kind} role="group" aria-label={group.label}>
              <div
                role="presentation"
                className="flex items-center gap-1.5 px-2.5 pt-2.5 pb-1 text-[11.5px] font-medium text-muted"
              >
                {group.label} <Count>{group.total}</Count>
              </div>
              {group.items.map((item) => {
                const at = position++
                return (
                  <Option
                    key={`${group.kind}:${item.id}`}
                    item={item}
                    index={at}
                    selected={at === selectedIndex}
                    query={parsed.text}
                    recent={group.kind === 'recent'}
                    theme={theme}
                    onHover={setIndex}
                    onRun={run}
                  />
                )
              })}
            </div>
          ))}
          {!results.groups.length ? (
            <p className="m-0 px-2.5 py-6 text-center text-muted">
              {searching
                ? 'Searching…'
                : parsed.text
                  ? `Nothing matches “${parsed.text}”${filter === 'all' ? '' : ` in ${filterLabels[filter]}`}.`
                  : 'Nothing here yet.'}
            </p>
          ) : null}
        </div>
        {selected?.repo ? <RepoPreview repo={selected.repo} can={can} onOpen={onClose} /> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3.5 border-t border-line bg-sunk px-3.5 py-2 text-xs text-muted">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd> close
        </span>
        <span className="flex-1" />
        <span className="flex flex-wrap items-center gap-1">
          Type <Kbd>&gt;</Kbd> for actions
          {canRepos ? (
            <>
              , <Kbd>#</Kbd> repositories
            </>
          ) : null}
          {canPeople ? (
            <>
              , <Kbd>@</Kbd> people
            </>
          ) : null}
        </span>
      </div>
    </div>
  )
}

function NewThread({ onClose }: { onClose: () => void }) {
  const threads = useChatThreads()
  const navigate = useNavigate()
  return (
    <NewThreadDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      groups={threads.data?.groups ?? []}
      onCreated={(thread) => void navigate({ to: '/chat', search: { thread } })}
    />
  )
}

/**
 * The ⌘K command palette: repositories with their health, libraries and exported symbols,
 * pages, settings, actions, people and recently opened items, filtered by chips or a `>`, `#`,
 * `@` prefix. Mounted once by the app shell and opened through `openPalette`.
 */
export function CommandPalette() {
  const open = usePaletteOpen()
  const [newThread, setNewThread] = useState(false)
  return (
    <>
      <Modal.Backdrop isOpen={open} onOpenChange={setPaletteOpen} variant="blur">
        <Modal.Container
          placement="top"
          className="mt-16 w-[min(880px,calc(100%-32px))] max-w-none!"
        >
          <Modal.Dialog
            aria-label="Command palette"
            className="w-full max-w-none! overflow-hidden rounded-[14px] border border-line-strong bg-panel p-0! shadow-[0_24px_64px_rgba(0,0,0,.45),0_2px_8px_rgba(0,0,0,.25)]"
          >
            <PaletteBody onClose={closePalette} onNewThread={() => setNewThread(true)} />
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
      {newThread ? <NewThread onClose={() => setNewThread(false)} /> : null}
    </>
  )
}
