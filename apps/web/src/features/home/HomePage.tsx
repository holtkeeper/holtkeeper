import type {
  HomeAttentionItem,
  HomeAttentionKind,
  HomeChange,
  HomeChangeKind,
  HomeRepoTile,
  HomeSpend,
  PersonView,
} from '@holtkeeper/api'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  BookOpen,
  CircleCheck,
  CircleX,
  Clock,
  FolderGit2,
  History,
  KeyRound,
  Lightbulb,
  type LucideIcon,
  Rocket,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react'

import { useHome } from '../../api/queries.ts'
import { automaticLimit, budgetBar, budgetTone, formatUsd } from '../../lib/ai-usage.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import {
  featureLabel,
  repoTicks,
  scopeHome,
  severityLabel,
  severityTone,
  spendSegments,
  tileRank,
} from '../../lib/home.ts'
import { personOf } from '../../lib/people.ts'
import {
  Avatar,
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  ScopeSwitch,
  SegmentBar,
  Tag,
  TickStrip,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'

const attentionIcons: Record<HomeAttentionKind, LucideIcon> = {
  'job-failures': CircleX,
  'budget-blocked': Wallet,
  vulnerabilities: ShieldAlert,
  allowlist: Clock,
  release: Rocket,
  learnings: Lightbulb,
  knowledge: BookOpen,
  'stale-analyses': History,
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
}

const repoPath = (key: string) => key.slice(key.indexOf(':') + 1)

function AttentionRow({ item, now }: { item: HomeAttentionItem; now: Date }) {
  const navigate = useNavigate()
  const Icon = attentionIcons[item.kind]
  const tone = severityTone[item.severity]
  const repos = item.repos.map((ref) => repoPath(ref.repo))
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={() => void navigate({ href: item.href })}
        className="grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2 text-left hover:bg-raise"
      >
        <Icon
          aria-hidden
          className={`mt-0.5 size-4 ${tone === 'danger' ? 'text-bad' : tone === 'warning' ? 'text-warn' : 'text-muted'}`}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <Tag tone={tone}>{severityLabel[item.severity]}</Tag>
            <span className="truncate font-medium">{item.title}</span>
          </span>
          {item.detail ? (
            <span className="truncate text-xs text-muted" title={item.detail}>
              {item.detail}
            </span>
          ) : null}
          {repos.length ? (
            <span className="mono truncate text-[11px] text-muted" title={repos.join(', ')}>
              {repos.length > 2
                ? `${repos.slice(0, 2).join(', ')} +${repos.length - 2}`
                : repos.join(', ')}
            </span>
          ) : null}
        </span>
        <time dateTime={item.at} className="mono text-[11px] whitespace-nowrap text-muted">
          {formatRelative(item.at, now)}
        </time>
      </button>
    </li>
  )
}

function SpendPanel({ spend }: { spend: HomeSpend }) {
  const bar = budgetBar(spend)
  const tone = budgetTone(spend)
  return (
    <Panel
      title="AI spend this week"
      actions={
        <Link
          to="/settings"
          search={{ tab: 'ai' }}
          className="text-xs text-muted hover:text-current"
        >
          Details
        </Link>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="mono text-xl font-semibold tabular">
            {formatUsd(spend.spentUsd)}
            <span className="text-sm font-normal text-muted"> / {formatUsd(spend.weeklyUsd)}</span>
          </span>
          <Tag tone={tone === 'success' ? 'success' : tone}>
            on pace for {formatUsd(spend.projectedUsd)}
          </Tag>
        </div>
        <div className="relative">
          <SegmentBar segments={spendSegments(spend)} total={spend.weeklyUsd} />
          {spend.reserveUsd > 0 ? (
            <span
              aria-hidden
              className="absolute -top-1 h-3.5 w-px bg-foreground"
              style={{ left: `${bar.reserve}%` }}
              title="Reserve for interactive work starts here"
            />
          ) : null}
        </div>
        <p className="text-xs text-muted">
          Automatic work {spend.action === 'block' ? 'stops' : 'warns'} at{' '}
          {formatUsd(automaticLimit(spend))}; {formatUsd(spend.reserveUsd)} stays for interactive
          work.
        </p>
        {spend.byFeature.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {spend.byFeature.slice(0, 5).map((entry) => (
              <li key={entry.feature} className="flex items-center justify-between gap-3">
                <span className="truncate">{featureLabel(entry.feature)}</span>
                <span className="mono text-xs text-muted tabular">
                  {formatUsd(entry.costUsd)} · {plural(entry.runs, 'run')}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No AI runs this week.</p>
        )}
      </div>
    </Panel>
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
  const actors = change.actors.slice(0, 3).map((id) => ({ id, ...personOf(people, id) }))
  return (
    <li className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
      <Icon aria-hidden className="size-4 shrink-0 text-muted" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{change.text}</span>
        {change.repo ? (
          <span className="mono truncate text-[11px] text-muted">{repoPath(change.repo.repo)}</span>
        ) : null}
      </span>
      <span className="flex -space-x-1">
        {actors.map((person) => (
          <Avatar key={person.id} src={person.avatarUrl} name={person.name} size="xs" />
        ))}
      </span>
      <time dateTime={change.lastAt} className="mono text-[11px] whitespace-nowrap text-muted">
        {formatRelative(change.lastAt, now)}
      </time>
    </li>
  )
}

function RepoTile({ tile }: { tile: HomeRepoTile }) {
  const ticks = repoTicks(tile)
  return (
    <Link
      to="/repos/view"
      search={{ repo: tile.repo }}
      className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 hover:border-line-strong hover:bg-raise"
    >
      <span className="mono truncate text-xs" title={tile.repo}>
        {repoPath(tile.repo)}
      </span>
      <TickStrip
        ticks={ticks}
        aria-label={ticks.map((tick) => tick.label).join('; ')}
        className="w-24"
      />
    </Link>
  )
}

/** Home: what needs the viewer, what changed this week, AI spend and the team's repositories. */
export function HomePage() {
  const home = useHome()
  const scope = useScope()
  const { can } = useSession()
  const readsRepos = can('repos:read')
  const now = new Date()

  if (home.isError)
    return (
      <Page title="Home">
        <ErrorState error={home.error} />
      </Page>
    )

  const scoped = home.data ? scopeHome(home.data, scope.view, scope.homeGroups) : undefined
  const tiles = scoped?.repos.toSorted(
    (a, b) => tileRank(a) - tileRank(b) || a.repo.localeCompare(b.repo),
  )

  return (
    <Page
      title="Home"
      icon="holtkeeper"
      actions={
        <ScopeSwitch
          value={scope.view}
          onChange={scope.setView}
          {...(scoped && { counts: scoped.counts })}
        />
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Needs attention"
          description={
            scoped ? plural(scoped.attention.length, 'item') : 'Failures, risks and waiting steps'
          }
          contentClassName="p-0"
        >
          {!scoped ? (
            <Placeholder className="h-48" />
          ) : scoped.attention.length ? (
            <ul className="rounded-lg border border-line">
              {scoped.attention.map((item) => (
                <AttentionRow key={item.id} item={item} now={now} />
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<CircleCheck />}
              title="All clear"
              description="Nothing in this scope waits for you."
            />
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          {home.data?.spend ? <SpendPanel spend={home.data.spend} /> : null}
          <Panel
            title="What changed"
            description={home.data ? `Last ${home.data.changesDays} days` : undefined}
            contentClassName="p-0"
          >
            {!scoped || !home.data ? (
              <Placeholder className="h-32" />
            ) : scoped.changes.length ? (
              <ul className="rounded-lg border border-line">
                {scoped.changes.slice(0, 12).map((change) => (
                  <ChangeRow
                    key={`${change.kind}-${change.text}-${change.repo?.repo ?? ''}`}
                    change={change}
                    people={home.data.people}
                    now={now}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState icon={<History />} title="Quiet week" />
            )}
          </Panel>
        </div>
      </div>

      {readsRepos || tiles?.length ? (
        <Panel
          title="Repositories"
          description="Jobs · vulnerabilities · release · analyses"
          {...(readsRepos && {
            actions: (
              <Link to="/repos" className="text-xs text-muted hover:text-current">
                All repositories
              </Link>
            ),
          })}
        >
          {!tiles ? (
            <Placeholder className="h-24" />
          ) : tiles.length ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {tiles.map((tile) => (
                <RepoTile key={tile.repo} tile={tile} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<ShieldCheck />}
              title="No repositories in this scope"
              description="Pick another scope or set your teams on the account page."
            />
          )}
        </Panel>
      ) : null}
    </Page>
  )
}
