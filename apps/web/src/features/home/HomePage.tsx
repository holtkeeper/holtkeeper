import type {
  HomeAttentionItem,
  HomeAttentionKind,
  HomeChange,
  HomeChangeKind,
  HomeSpend,
  PersonView,
  RepoHealthCellKey,
  RepoRef,
} from '@holtkeeper/api'
import { Link, type LinkProps, useNavigate } from '@tanstack/react-router'
import {
  ArrowUpRight,
  BookOpen,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  FolderGit2,
  History,
  KeyRound,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  Rocket,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react'
import { type MouseEvent, type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useHome,
  useInboxCount,
  useRepos,
  useRetryAttention,
  useSnoozeMutations,
} from '../../api/queries.ts'
import { automaticLimit, budgetBar, budgetTone, formatUsd } from '../../lib/ai-usage.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import {
  type AttentionGrouping,
  type RankedRepo,
  attentionKindLabel,
  groupAttention,
  cellTones,
  fleetCounts,
  fleetTicks,
  healthCells,
  healthLabels,
  healthOrder,
  healthTones,
  repoHealth,
  scopeHome,
  severityLabel,
  severityTone,
  spendSegments,
} from '../../lib/home.ts'
import { snoozeUntil } from '../../lib/inbox.ts'
import { personOf } from '../../lib/people.ts'
import { hubSearch } from '../../lib/repo-page.ts'
import { type RepoHubTab, repoSplat } from '../../lib/repo.ts'
import {
  Avatar,
  Button,
  Count,
  Dot,
  EmptyState,
  ErrorState,
  FilterButton,
  HealthCell,
  Legend,
  LinkButton,
  Page,
  Placeholder,
  SegmentedTabs,
  Strip,
  type StripCell,
  Table,
  Tag,
  Td,
  Th,
  TickStrip,
  Tr,
  buttonClass,
  notify,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'

const attentionIcons: Record<HomeAttentionKind, LucideIcon> = {
  'job-failures': CircleX,
  'budget-blocked': Wallet,
  vulnerabilities: ShieldAlert,
  allowlist: Clock,
  'allowlist-expiring': Clock,
  release: Rocket,
  learnings: Lightbulb,
  knowledge: BookOpen,
  'stale-analyses': History,
  'not-analysed': CircleDashed,
}

const changeIcons: Record<HomeChangeKind, LucideIcon> = {
  release: Rocket,
  deploy: Rocket,
  settings: Settings2,
  knowledge: BookOpen,
  guide: BookOpen,
  repo: FolderGit2,
  credentials: KeyRound,
  access: Users,
  task: ListChecks,
}

const cellTabs: Record<RepoHealthCellKey, [RepoHubTab, string?]> = {
  security: ['supply', 'security'],
  dependencies: ['supply', 'libraries'],
  licenses: ['supply', 'licenses'],
  coverage: ['quality', 'coverage'],
  bundles: ['quality', 'bundles'],
  ci: ['quality', 'ci'],
  release: ['releases'],
  jobs: ['activity'],
}

const cellLink = (key: RepoHealthCellKey, repo: RepoRef): LinkProps => {
  const [tab, section] = cellTabs[key]
  return { to: '/repos/$', params: { _splat: repoSplat(repo) }, search: hubSearch(tab, section) }
}

const repoPath = (key: string) => key.slice(key.indexOf(':') + 1)

const onError = (title: string) => (error: Error) => notify.error(title, messageOf(error))

/** A link to a server-built panel path (query string included) that the router follows. */
function HrefLink({
  href,
  className,
  children,
  ...rest
}: {
  href: string
  className?: string
  children: ReactNode
  'aria-label'?: string
}) {
  const navigate = useNavigate()
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return
    event.preventDefault()
    void navigate({ href })
  }
  return (
    <a href={href} onClick={onClick} className={className} {...rest}>
      {children}
    </a>
  )
}

function Section({
  title,
  count,
  caption,
  actions,
  className = '',
  children,
}: {
  title: string
  count?: number
  caption?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section
      aria-label={title}
      className={`flex min-w-0 flex-col rounded-[10px] border border-line bg-sunk ${className}`}
    >
      <header className="flex min-h-[46px] flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {count === undefined ? null : <Count>{count}</Count>}
        {caption ? <span className="text-xs text-muted">{caption}</span> : null}
        {actions ? <div className="ms-auto flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

function AttentionTable({
  items,
  grouping,
  snoozed,
  now,
}: {
  items: HomeAttentionItem[]
  grouping: AttentionGrouping
  snoozed: boolean
  now: Date
}) {
  const retry = useRetryAttention()
  const { snooze, unsnooze } = useSnoozeMutations()
  return (
    <Table label="Needs attention">
      <thead>
        <tr>
          <Th>Severity</Th>
          <Th>Item</Th>
          <Th>Where</Th>
          <Th>Age</Th>
          <Th>
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      {groupAttention(items, grouping, snoozed).map((group) => (
        <tbody key={group.key}>
          <tr>
            <th
              colSpan={5}
              scope="colgroup"
              className="border-b border-line bg-raise/40 px-3.5 py-1.5 text-left text-[11.5px] font-medium text-muted"
            >
              {group.label}
              <span className="mono ms-2 text-dim">{group.items.length}</span>
            </th>
          </tr>
          {group.items.map((item) => {
            const Icon = attentionIcons[item.kind]
            const repos = item.repos.map((ref) => repoPath(ref.repo))
            const { action } = item
            return (
              <Tr key={item.id}>
                <Td>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <Dot tone={severityTone[item.severity]} />
                    {severityLabel[item.severity]}
                  </span>
                </Td>
                <Td className="max-w-[28rem]">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{item.title}</span>
                        {item.snoozed ? <Tag>Snoozed</Tag> : null}
                      </div>
                      <div className="truncate text-xs text-muted" title={item.detail}>
                        {attentionKindLabel[item.kind]}
                        {item.detail ? ` · ${item.detail}` : ''}
                      </div>
                    </div>
                  </div>
                </Td>
                <Td>
                  {repos.length ? (
                    <span className="mono text-xs whitespace-nowrap" title={repos.join(', ')}>
                      {repos[0]}
                      {repos.length > 1 ? (
                        <span className="text-dim"> +{repos.length - 1}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-dim">—</span>
                  )}
                </Td>
                <Td>
                  <time dateTime={item.at} className="mono text-xs whitespace-nowrap text-muted">
                    {formatRelative(item.at, now)}
                  </time>
                </Td>
                <Td>
                  <div className="flex items-center justify-end gap-1">
                    {action.type === 'retry' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        isPending={retry.isPending && retry.variables?.analyzer === action.analyzer}
                        onPress={() =>
                          retry.mutate(
                            {
                              analyzer: action.analyzer,
                              repos: item.repos.map((ref) => ref.repo),
                            },
                            {
                              onSuccess: () => notify.success('Queued again', item.title),
                              onError: onError('Not queued'),
                            },
                          )
                        }
                      >
                        {action.label}
                      </Button>
                    ) : (
                      <HrefLink href={action.href} className={buttonClass('secondary', 'sm')}>
                        {action.label}
                      </HrefLink>
                    )}
                    {item.snoozed ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Unsnooze: ${item.title}`}
                        onPress={() =>
                          unsnooze.mutate(item.id, { onError: onError('Not unsnoozed') })
                        }
                      >
                        Unsnooze
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Snooze: ${item.title}`}
                        onPress={() =>
                          snooze.mutate(
                            { id: item.id, until: snoozeUntil(new Date()) },
                            { onError: onError('Not snoozed') },
                          )
                        }
                      >
                        Snooze
                      </Button>
                    )}
                    {action.type === 'retry' ? (
                      <HrefLink
                        href={item.href}
                        aria-label={`Open: ${item.title}`}
                        className="grid size-7 place-items-center rounded-[7px] text-muted hover:bg-raise hover:text-foreground"
                      >
                        <ArrowUpRight aria-hidden className="size-3.5" />
                      </HrefLink>
                    ) : null}
                  </div>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      ))}
    </Table>
  )
}

function FleetHealth({ ranked }: { ranked: RankedRepo[] }) {
  const counts = fleetCounts(ranked.map((entry) => entry.summary))
  const summary = healthOrder
    .filter((status) => counts.byStatus[status] > 0)
    .map((status) => `${counts.byStatus[status]} ${healthLabels[status].toLowerCase()}`)
    .join(', ')
  return (
    <Section
      title="Fleet health"
      caption={`${plural(counts.repos, 'repository', 'repositories')}, worst first`}
      actions={
        <LinkButton to="/repos" variant="ghost" size="sm">
          All repositories
        </LinkButton>
      }
    >
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        {ranked.length ? (
          <TickStrip
            ticks={fleetTicks(ranked)}
            aria-label={`${plural(counts.repos, 'repository', 'repositories')}: ${summary}`}
            className="h-[22px]"
          />
        ) : (
          <p className="text-xs text-muted">No repositories in this scope.</p>
        )}
        <Legend
          label="Fleet health legend"
          className="grid grid-cols-2"
          items={healthOrder.map((status) => ({
            tone: healthTones[status],
            label: (
              <span className="flex flex-1 items-center gap-1.5">
                {healthLabels[status]}
                <b className="tabular ms-auto font-semibold text-foreground">
                  {counts.byStatus[status]}
                </b>
              </span>
            ),
          }))}
        />
        <p className="text-xs text-muted">
          {counts.staleAnalyses
            ? `${plural(counts.staleAnalyses, 'stale analysis', 'stale analyses')} across the fleet.`
            : 'Every analysis is current.'}
        </p>
      </div>
    </Section>
  )
}

const teamsLink = { to: '/account/$section', params: { section: 'teams' } } as const

function WorstRepos({ ranked: all, now }: { ranked: RankedRepo[]; now: Date }) {
  const [groups, setGroups] = useState<string[]>([])
  const groupOptions = [...new Set(all.flatMap((entry) => entry.summary.groups))]
    .toSorted()
    .map((group) => ({ id: group, label: group }))
  const ranked = groups.length
    ? all.filter((entry) => entry.summary.groups.some((group) => groups.includes(group)))
    : all
  const worst = ranked.slice(0, 10)
  const columns = healthCells.filter((column) =>
    worst.some((entry) => entry.summary.cells[column.key] !== undefined),
  )
  return (
    <Section
      title="Repositories"
      count={ranked.length}
      caption="Worst first"
      className="lg:col-span-2"
      actions={
        <>
          {groupOptions.length ? (
            <FilterButton
              label="Group"
              all="All"
              options={groupOptions}
              value={groups}
              onChange={setGroups}
            />
          ) : null}
          <Legend
            label="Cell legend"
            items={[
              { tone: 'success', label: 'OK' },
              { tone: 'warning', label: 'Attention' },
              { tone: 'danger', label: 'Failing' },
              { tone: 'none', label: 'No data' },
            ]}
          />
        </>
      }
    >
      {worst.length ? (
        <Table label="Worst repositories">
          <thead>
            <tr>
              <Th>Repository</Th>
              <Th>Group</Th>
              <Th>Health</Th>
              {columns.map((column) => (
                <Th key={column.key}>{column.label}</Th>
              ))}
              <Th>Analysed</Th>
            </tr>
          </thead>
          <tbody>
            {worst.map(({ summary, key }) => (
              <Tr key={key}>
                <Td>
                  <LinkButton
                    to="/repos/$"
                    params={{ _splat: repoSplat(summary.repo) }}
                    variant="ghost"
                    size="sm"
                    className="mono -ms-2.5"
                  >
                    {summary.repo.path}
                  </LinkButton>
                </Td>
                <Td className="text-muted">{summary.groups.join(', ') || '—'}</Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <Dot tone={healthTones[summary.health]} />
                    {healthLabels[summary.health]}
                  </span>
                </Td>
                {columns.map((column) => {
                  const cell = summary.cells[column.key]
                  return (
                    <Td key={column.key}>
                      {cell ? (
                        <HealthCell
                          tone={cellTones[cell.tone]}
                          value={cell.value}
                          {...(cell.sub ? { caption: cell.sub } : {})}
                          link={cellLink(column.key, summary.repo)}
                        />
                      ) : (
                        <span className="text-dim">—</span>
                      )}
                    </Td>
                  )
                })}
                <Td>
                  <span className="mono text-xs whitespace-nowrap text-muted">
                    {summary.lastAnalysedAt ? formatRelative(summary.lastAnalysedAt, now) : 'Never'}
                  </span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState
          icon={<ShieldCheck />}
          title="No repositories in this scope"
          description={
            <>
              Pick another scope or{' '}
              <Link {...teamsLink} className="text-foreground underline">
                set your teams
              </Link>{' '}
              on the account page.
            </>
          }
        />
      )}
      <footer className="flex flex-wrap items-center gap-3 border-t border-line px-3.5 py-2.5 text-xs text-muted">
        {ranked.length > worst.length ? (
          <span>
            Showing the {worst.length} worst of {ranked.length}.
          </span>
        ) : null}
        <span>
          Scope follows{' '}
          <Link {...teamsLink} className="text-foreground hover:underline">
            My teams
          </Link>{' '}
          in your account.
        </span>
        {ranked.length > worst.length ? (
          <LinkButton to="/repos" size="sm" className="ms-auto">
            Show all {ranked.length}
          </LinkButton>
        ) : null}
      </footer>
    </Section>
  )
}

function SpendCard({ spend }: { spend: HomeSpend }) {
  const bar = budgetBar(spend)
  const tone = budgetTone(spend)
  const segments = spendSegments(spend)
  const share = (cost: number) =>
    spend.weeklyUsd > 0 ? Math.min(100, (cost / spend.weeklyUsd) * 100) : 0
  return (
    <Section
      title="AI spend this week"
      actions={
        <LinkButton to="/ops/spend" variant="ghost" size="sm">
          Details
        </LinkButton>
      }
    >
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="mono text-xl font-semibold tabular">{formatUsd(spend.spentUsd)}</span>
          <span className="text-muted">
            of <span className="mono">{formatUsd(spend.weeklyUsd)}</span>
          </span>
          <Tag tone={tone} className="ms-auto">
            On pace for {formatUsd(spend.forecastUsd)}
          </Tag>
        </div>
        <div
          role="img"
          aria-label={`Spent ${formatUsd(spend.spentUsd)} of ${formatUsd(spend.weeklyUsd)}; automatic work ${spend.action === 'block' ? 'stops' : 'warns'} at ${formatUsd(automaticLimit(spend))}`}
          className="relative flex h-2.5 gap-px rounded-[5px] bg-raise shadow-[inset_0_0_0_1px_var(--line)]"
        >
          {segments.map((segment, index) => (
            <span
              key={segment.label}
              className={`block h-full ${index === 0 ? 'rounded-s-[5px]' : ''}`}
              style={{ width: `${share(segment.costUsd)}%`, background: segment.color }}
            />
          ))}
          {spend.reserveUsd > 0 ? (
            <span
              aria-hidden
              className="absolute -top-1 -bottom-1 w-0.5 rounded-[1px] bg-foreground"
              style={{ left: `${bar.reserve}%` }}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-[11.5px] text-muted">
          <span className="mono">$0</span>
          <span className="ms-auto">
            Automatic work {spend.action === 'block' ? 'stops' : 'warns'} at{' '}
            <span className="mono text-foreground">{formatUsd(automaticLimit(spend))}</span>
          </span>
          <span className="mono">{formatUsd(spend.weeklyUsd)}</span>
        </div>
        <p className="text-xs text-muted">
          {spend.reserveUsd > 0 ? (
            <>
              The last <span className="mono">{formatUsd(spend.reserveUsd)}</span> stays for
              interactive work: chat and manual runs.{' '}
            </>
          ) : null}
          Resets Monday.
        </p>
        {segments.length ? (
          <ul aria-label="Spend by feature" className="flex flex-col gap-1.5 text-[12.5px]">
            {segments.map((segment) => (
              <li key={segment.label} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block size-[9px] shrink-0 rounded-[2px]"
                  style={{ background: segment.color }}
                />
                <span className="truncate">{segment.label}</span>
                <span className="mono ms-auto text-muted">{plural(segment.runs, 'run')}</span>
                <span className="mono w-16 text-right">{formatUsd(segment.costUsd)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No AI runs this week.</p>
        )}
      </div>
    </Section>
  )
}

function ChangeRow({
  change,
  people,
  now,
}: {
  change: HomeChange
  people: Record<string, PersonView>
  now: Date
}) {
  const Icon = changeIcons[change.kind]
  const person = personOf(people, change.actor)
  return (
    <li>
      <HrefLink
        href={change.href}
        className="flex items-center gap-2.5 px-3.5 py-[7px] text-[12.5px] text-foreground no-underline hover:bg-raise"
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{change.text}</span>
          {change.repo ? (
            <span className="mono truncate text-[11.5px] text-dim">
              {repoPath(change.repo.repo)}
            </span>
          ) : null}
        </span>
        <Avatar src={person.avatarUrl} name={person.name} size="xs" />
        <time dateTime={change.at} className="mono text-[11.5px] whitespace-nowrap text-dim">
          {formatRelative(change.at, now)}
        </time>
      </HrefLink>
    </li>
  )
}

const crumbs = [{ label: 'Overview' }] as const

const groupings: readonly { id: AttentionGrouping; label: string }[] = [
  { id: 'severity', label: 'By severity' },
  { id: 'kind', label: 'By kind' },
  { id: 'repo', label: 'By repository' },
]

/** Home: fleet health, what needs the viewer, what changed this week and AI spend. */
export function HomePage() {
  const home = useHome()
  const scope = useScope()
  const { can } = useSession()
  const readsRepos = can('repos:read')
  const repos = useRepos(readsRepos)
  const inbox = useInboxCount()
  const [grouping, setGrouping] = useState<AttentionGrouping>('severity')
  const [showSnoozed, setShowSnoozed] = useState(false)
  const now = new Date()

  if (home.isError)
    return (
      <Page crumbs={crumbs} title="Home">
        <ErrorState error={home.error} />
      </Page>
    )

  const scoped = home.data ? scopeHome(home.data, scope.view, scope.homeGroups) : undefined
  const scopedRepos = repos.data ? scope.scope(repos.data.repos) : undefined
  const ranked = scopedRepos ? repoHealth(scopedRepos.shown) : undefined
  const fleet = ranked ? fleetCounts(ranked.map((entry) => entry.summary)) : undefined
  const open = scoped?.attention.filter((item) => !item.snoozed).length
  const snoozed = scoped ? scoped.attention.length - (open ?? 0) : 0
  const waiting = inbox.data?.total

  const strip: StripCell[] = [
    ...(fleet
      ? [
          { value: fleet.repos, label: fleet.repos === 1 ? 'repository' : 'repositories' },
          ...healthOrder.map((status) => ({
            value: fleet.byStatus[status],
            label: healthLabels[status].toLowerCase(),
            tone: healthTones[status],
          })),
        ]
      : []),
    ...(open === undefined ? [] : [{ value: open, label: 'need attention' }]),
    ...(waiting === undefined ? [] : [{ value: waiting, label: 'waiting in your inbox' }]),
    ...(fleet
      ? [
          {
            value: fleet.staleAnalyses,
            label: fleet.staleAnalyses === 1 ? 'stale analysis' : 'stale analyses',
            end: true,
          },
        ]
      : []),
  ]

  return (
    <Page
      crumbs={crumbs}
      title="Home"
      scope={{
        value: scope.view,
        onChange: scope.setView,
        ...(scopedRepos && { counts: scopedRepos.counts }),
      }}
      primary={{
        label: (
          <>
            Review inbox
            {waiting ? <span className="mono opacity-70">{waiting}</span> : null}
          </>
        ),
        link: { to: '/inbox' },
      }}
    >
      {strip.length ? <Strip cells={strip} className="-mx-4 -mt-4" /> : null}

      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Section
          title="Needs attention"
          {...(open === undefined ? {} : { count: open })}
          actions={
            <>
              <SegmentedTabs
                aria-label="Group needs attention"
                items={groupings}
                selected={grouping}
                onSelect={(id) =>
                  setGrouping(groupings.find((each) => each.id === id)?.id ?? 'severity')
                }
              />
              {snoozed ? (
                <button
                  type="button"
                  aria-pressed={showSnoozed}
                  onClick={() => setShowSnoozed(!showSnoozed)}
                  className={buttonClass(showSnoozed ? 'secondary' : 'ghost', 'sm')}
                >
                  Snoozed <span className="mono opacity-70">{snoozed}</span>
                </button>
              ) : null}
            </>
          }
        >
          {!scoped ? (
            <Placeholder className="m-3.5 h-48" />
          ) : open || (showSnoozed && snoozed) ? (
            <AttentionTable
              items={scoped.attention}
              grouping={grouping}
              snoozed={showSnoozed}
              now={now}
            />
          ) : (
            <EmptyState
              icon={<CircleCheck />}
              title="All clear"
              description={
                snoozed
                  ? `Nothing else in this scope waits for you; ${plural(snoozed, 'item is', 'items are')} snoozed.`
                  : 'Nothing in this scope waits for you.'
              }
            />
          )}
          {open || (showSnoozed && snoozed) ? (
            <footer className="border-t border-line px-3.5 py-2.5 text-xs text-muted">
              Sorted by severity, then age. Snoozed items come back after a day.
            </footer>
          ) : null}
        </Section>

        <div className="flex min-w-0 flex-col gap-3">
          {readsRepos ? (
            ranked ? (
              <FleetHealth ranked={ranked} />
            ) : (
              <Placeholder className="h-40" />
            )
          ) : null}
          {home.data?.spend ? <SpendCard spend={home.data.spend} /> : null}
          <Section
            title="What changed"
            {...(home.data ? { caption: `Last ${home.data.changesDays} days` } : {})}
            actions={
              <LinkButton
                to="/settings/$section"
                params={{ section: 'audit' }}
                variant="ghost"
                size="sm"
              >
                Full history
              </LinkButton>
            }
          >
            {!scoped || !home.data ? (
              <Placeholder className="m-3.5 h-32" />
            ) : scoped.changes.length ? (
              <ul className="py-1">
                {scoped.changes.slice(0, 12).map((change) => (
                  <ChangeRow key={change.id} change={change} people={home.data.people} now={now} />
                ))}
              </ul>
            ) : (
              <EmptyState icon={<History />} title="Quiet week" />
            )}
          </Section>
        </div>

        {readsRepos ? (
          ranked ? (
            <WorstRepos ranked={ranked} now={now} />
          ) : (
            <Placeholder className="h-48 lg:col-span-2" />
          )
        ) : null}
      </div>
    </Page>
  )
}
