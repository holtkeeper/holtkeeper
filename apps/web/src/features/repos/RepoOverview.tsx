import {
  type PersonView,
  type RepoOverview as Overview,
  type RepoRef,
  leafGroups,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ArrowRight, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { useRepoHistory } from '../../api/queries.ts'
import { actionLabel, outcomeTone } from '../../lib/audit-log.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { freshnessLabel, freshnessTone } from '../../lib/freshness.ts'
import { cellTones } from '../../lib/home.ts'
import { personOf } from '../../lib/people.ts'
import {
  type DeliveryCard,
  accessText,
  cardLabels,
  cardTarget,
  deliveryCards,
  freshnessRows,
  freshnessTally,
  hubSearch,
  stripCells,
} from '../../lib/repo-page.ts'
import { repoKey } from '../../lib/repo.ts'
import { formatValue } from '../../lib/units.ts'
import {
  CopyButton,
  Dot,
  GroupName,
  KeyValue,
  Placeholder,
  Table,
  Tag,
  Td,
  Th,
} from '../../ui/index.ts'
import { HubCard, HubLink, hubLinkClass } from '../repo/HubCard.tsx'
import { useSession } from '../shell/session.ts'

const shortSha = (sha: string) => sha.slice(0, 7)

function Block({
  title,
  hint,
  link,
  children,
}: {
  title: string
  hint: string
  link?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5 border-b border-line p-3.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <span className="text-xs text-muted">{hint}</span>
        {link ? <span className="ms-auto">{link}</span> : null}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-2.5">{children}</div>
    </section>
  )
}

function deliveryLink(repo: RepoRef, key: DeliveryCard['key']): ReactNode {
  if (key === 'work')
    return (
      <Link to="/ops/runs" search={{ repo: repoKey(repo) }} className={hubLinkClass}>
        Open
        <ArrowRight className="size-3" />
      </Link>
    )
  const search =
    key === 'releases'
      ? hubSearch('releases')
      : key === 'reviews'
        ? hubSearch('quality', 'reviews')
        : hubSearch('knowledge')
  return (
    <HubLink repo={repo} search={search}>
      Open
    </HubLink>
  )
}

function FreshnessTable({ repo, overview }: { repo: RepoRef; overview: Overview }) {
  const rows = freshnessRows(overview)
  const tally = freshnessTally(rows)
  const legend = [
    { tone: 'success' as const, count: tally.current, label: 'current' },
    { tone: 'info' as const, count: tally.behind, label: 'behind HEAD' },
    { tone: 'warning' as const, count: tally.aging, label: 'over a week old' },
    { tone: 'danger' as const, count: tally.bad, label: 'failed or month old' },
  ]
  return (
    <section
      aria-labelledby="hub-freshness"
      className="flex min-w-0 flex-[999_1_640px] flex-col rounded-[10px] border border-line bg-sunk"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-[11px]">
        <h2 id="hub-freshness" className="text-[13px] font-semibold">
          Freshness
        </h2>
        <span className="text-xs text-muted">Latest record of every analysis, worst first</span>
        <span className="ms-auto flex flex-wrap items-center gap-3 text-xs text-muted">
          {legend.map((entry) => (
            <span key={entry.label} className="inline-flex items-center gap-1.5">
              <Dot tone={entry.tone} />
              <b className="font-semibold text-foreground">{entry.count}</b> {entry.label}
            </span>
          ))}
          <Link to="/ops/runs" search={{ repo: repoKey(repo) }} className={hubLinkClass}>
            Runs
            <ArrowRight className="size-3" />
          </Link>
        </span>
      </div>
      {rows.length ? (
        <Table label="Freshness of every analysis">
          <thead>
            <tr>
              <Th>Analysis kind</Th>
              <Th>Headline</Th>
              <Th>Last run</Th>
              <Th>Commit</Th>
              <Th>Age</Th>
              <Th>Status</Th>
              <Th>
                <span className="sr-only">Open</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ record, freshness }) => (
              <tr key={record.id}>
                <Td>
                  <Link
                    to="/analyses/$id"
                    params={{ id: record.id }}
                    search={{}}
                    className="font-medium text-foreground no-underline hover:underline"
                  >
                    {record.label}
                  </Link>
                </Td>
                <Td className="max-w-72 truncate text-muted">
                  {record.metrics
                    .slice(0, 2)
                    .map((metric) => `${metric.label} ${formatValue(metric.value, metric.unit)}`)
                    .join(' · ')}
                </Td>
                <Td className="text-muted">{formatDateTime(record.createdAt)}</Td>
                <Td className="mono">{record.sha ? shortSha(record.sha) : '—'}</Td>
                <Td className="mono text-muted">{formatRelative(record.createdAt)}</Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5">
                    <Dot tone={freshnessTone[freshness]} />
                    {freshnessLabel[freshness]}
                  </span>
                </Td>
                <Td align="right">
                  <Link
                    to="/analyses/$id"
                    params={{ id: record.id }}
                    search={{}}
                    aria-label={`Open latest ${record.label} record`}
                    className="inline-grid size-7 place-items-center rounded-[7px] text-muted hover:bg-raise hover:text-foreground"
                  >
                    <ChevronRight className="size-3.5" />
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="px-3.5 py-3 text-sm text-muted">Nothing analysed yet.</p>
      )}
    </section>
  )
}

function Facts({ repo, overview }: { repo: RepoRef; overview: Overview }) {
  return (
    <section
      aria-labelledby="hub-facts"
      className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-sunk px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        <h2 id="hub-facts" className="text-[13px] font-semibold">
          Repository
        </h2>
        <span className="ms-auto">
          <HubLink repo={repo} search={hubSearch('settings')}>
            Settings
          </HubLink>
        </span>
      </div>
      <KeyValue
        rows={[
          { label: 'Forge', value: <span className="mono">{repo.forge}</span> },
          {
            label: 'Path',
            value: (
              <>
                <span className="mono min-w-0 break-all">{repo.path}</span>
                <span className="shrink-0">
                  <CopyButton text={() => repo.path} variant="ghost">
                    Copy
                  </CopyButton>
                </span>
              </>
            ),
          },
          {
            label: 'Default branch',
            value: overview.defaultBranch ? (
              <span className="mono">{overview.defaultBranch}</span>
            ) : null,
          },
          {
            label: 'HEAD',
            value: overview.head ? (
              <span className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="mono">{shortSha(overview.head.sha)}</span>
                <span className="whitespace-nowrap text-muted">
                  since {formatRelative(overview.head.at)}
                </span>
              </span>
            ) : null,
          },
          {
            label: 'Groups',
            value: overview.groups.length ? (
              <span className="flex min-w-0 flex-wrap gap-1">
                {leafGroups(overview.groups).map((group) => (
                  <Link
                    key={group}
                    to="/repos/groups/$groupId"
                    params={{ groupId: group }}
                    className="flex min-w-0 max-w-full no-underline"
                  >
                    <Tag className="max-w-full">
                      <span className="truncate">
                        <GroupName group={group} path />
                      </span>
                    </Tag>
                  </Link>
                ))}
              </span>
            ) : null,
          },
          {
            label: 'Toolchain',
            value: overview.toolchain.length ? (
              <span className="mono min-w-0 break-words">
                {overview.toolchain.map((tool) => `${tool.name} ${tool.version}`).join(' · ')}
              </span>
            ) : null,
          },
          { label: 'Access', value: accessText(overview.access) },
        ]}
      />
    </section>
  )
}

function ActivityFeed({ repo }: { repo: RepoRef }) {
  const history = useRepoHistory(repo, 6)
  return (
    <section
      aria-labelledby="hub-activity"
      className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-sunk px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        <h2 id="hub-activity" className="text-[13px] font-semibold">
          Recent activity
        </h2>
        <span className="ms-auto">
          <HubLink repo={repo} search={hubSearch('activity')}>
            Activity
          </HubLink>
        </span>
      </div>
      {history.isPending ? (
        <Placeholder className="h-24" />
      ) : history.isError || !history.data.events.length ? (
        <p className="text-xs text-muted">
          {history.isError ? 'Activity could not be read.' : 'Nothing happened here yet.'}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-xs">
          {history.data.events.map((event) => {
            const person: PersonView = personOf(history.data.people, event.actor.id)
            return (
              <li key={event.id} className="flex items-start gap-2">
                <span className="pt-[5px]">
                  <Dot tone={outcomeTone(event.outcome)} />
                </span>
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="truncate">
                    {actionLabel(event.action)}
                    {event.outcome === 'ok' ? '' : ` · ${event.outcome}`}
                  </span>
                  <span className="text-[11.5px] text-muted">
                    <span className="mono">{event.id.slice(0, 8)}</span> ·{' '}
                    <time dateTime={event.at} title={formatDateTime(event.at)}>
                      {formatRelative(event.at)}
                    </time>{' '}
                    · {person.name}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * The hub's health strip: one entry per health cell the caller may read, each named and with its
 * status in words, then the default-branch head freshness last saw.
 */
export function RepoHealthStrip({ overview }: { overview: Overview | undefined }) {
  const cells = overview
    ? stripCells.flatMap(({ key, label }) => {
        const cell = overview.cells[key]
        return cell ? [{ key, label, cell }] : []
      })
    : []
  return (
    <ul
      aria-label="Health"
      className="m-0 flex list-none flex-wrap items-center gap-x-[18px] gap-y-1.5 border-b border-line px-3.5 py-2.5 text-xs text-muted"
    >
      <li className="text-[11.5px] font-medium">Health</li>
      {overview && !cells.length ? <li>Nothing you may see is analysed yet.</li> : null}
      {cells.map(({ key, label, cell }) => (
        <li key={key} className="inline-flex items-center gap-1.5" title={cell.sub || undefined}>
          {label}
          <span className="inline-flex items-center gap-[5px] font-medium text-foreground">
            <Dot tone={cellTones[cell.tone]} />
            {cell.value}
          </span>
        </li>
      ))}
      {overview?.head ? (
        <li className="ms-auto">
          HEAD <b className="mono font-semibold text-foreground">{shortSha(overview.head.sha)}</b>{' '}
          since {formatRelative(overview.head.at)}
        </li>
      ) : null}
    </ul>
  )
}

/**
 * The hub's Overview tab: Supply chain and Quality cards from the server, Delivery and activity
 * cards, the freshness of every analysis, the repository's facts and its recent audit events.
 */
export function RepoOverview({ repo, overview }: { repo: RepoRef; overview: Overview }) {
  const { can } = useSession()
  const cards = (section: 'supply' | 'quality') =>
    overview.cards
      .filter((card) => card.section === section)
      .map((card) => (
        <HubCard
          key={card.key}
          card={{ ...card, label: cardLabels[card.key] }}
          open={
            <HubLink repo={repo} search={cardTarget(card)}>
              Open
            </HubLink>
          }
        />
      ))
  return (
    <div className="-mx-4 -mt-4 flex flex-col">
      <Block
        title="Supply chain"
        hint="What the repository pulls in and whether it is safe"
        link={
          <HubLink repo={repo} search={hubSearch('supply')}>
            Supply chain tab
          </HubLink>
        }
      >
        {cards('supply')}
      </Block>
      <Block
        title="Quality"
        hint="Tests, size, pipelines and branch hygiene"
        link={
          <HubLink repo={repo} search={hubSearch('quality')}>
            Quality tab
          </HubLink>
        }
      >
        {cards('quality')}
      </Block>
      <Block title="Delivery and activity" hint="Releases, reviews, agent work and team knowledge">
        {deliveryCards(overview, can('releases:read')).map((card) => (
          <HubCard key={card.key} card={card} open={deliveryLink(repo, card.key)} />
        ))}
      </Block>
      <div className="flex flex-wrap items-start gap-3 p-3.5">
        <FreshnessTable repo={repo} overview={overview} />
        <div className="flex max-w-[400px] min-w-0 flex-[1_1_300px] flex-col gap-3">
          <Facts repo={repo} overview={overview} />
          {can('repos:read') || can('audit:read') ? <ActivityFeed repo={repo} /> : null}
        </div>
      </div>
    </div>
  )
}
