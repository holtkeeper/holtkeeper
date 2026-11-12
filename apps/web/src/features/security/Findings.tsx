import type { RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ChevronRight, ShieldCheck } from 'lucide-react'

import { useFindings } from '../../api/queries.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import { foldOtherTeams } from '../../lib/home-scope.ts'
import { parseRepoKey, repoKey, repoSplat } from '../../lib/repo.ts'
import {
  type FindingGroupRow,
  type FindingsSort,
  type SecuritySearch,
  filterFindings,
  findingCounts,
  findingEcosystems,
  findingRows,
  findingStatusLabel,
  findingStatusTone,
  parseSecuritySearch,
  sortFindings,
  statusNote,
} from '../../lib/security.ts'
import { severities, severityLabel, severityTone } from '../../lib/severity.ts'
import {
  EmptyState,
  ErrorState,
  type FleetColumn,
  FilterButton,
  FleetTable,
  Placeholder,
  Select,
  type StripCell,
  Tag,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { FindingSheet } from './FindingSheet.tsx'

const sortOptions: { id: FindingsSort; label: string }[] = [
  { id: 'severity', label: 'Sort: Severity' },
  { id: 'repos', label: 'Sort: Repositories' },
  { id: 'seen', label: 'Sort: First seen' },
  { id: 'package', label: 'Sort: Package' },
]

const statusOptions = (['open', 'fixing', 'allowlisted'] as const).map((id) => ({
  id,
  label: findingStatusLabel[id],
}))

function RepoCell({ row }: { row: FindingGroupRow }) {
  const [first, ...rest] = row.group.repos
  const ref = parseRepoKey(first?.repo)
  if (!first || !ref) return null
  return (
    <span className="flex flex-col leading-tight">
      <Link
        to="/repos/$"
        params={{ _splat: repoSplat(ref) }}
        search={{ tab: 'supply', section: 'security' }}
        className="mono truncate text-[12.5px] hover:underline"
      >
        {ref.path}
      </Link>
      {rest.length ? <span className="text-[11px] text-dim">+{rest.length} more</span> : null}
    </span>
  )
}

const columns: readonly FleetColumn<FindingGroupRow>[] = [
  {
    id: 'advisory',
    header: 'Advisory',
    className: 'min-w-44',
    cell: ({ group }) => (
      <span className="flex flex-col leading-tight">
        <span className="mono text-[12.5px]">{group.advisory}</span>
        {group.aliases[0] ? (
          <span className="mono text-[11px] text-dim">{group.aliases[0]}</span>
        ) : null}
      </span>
    ),
  },
  {
    id: 'severity',
    header: 'Severity',
    cell: ({ group }) => (
      <Tag tone={severityTone(group.severity)} dot>
        {severityLabel[group.severity]}
      </Tag>
    ),
  },
  {
    id: 'package',
    header: 'Package',
    cell: ({ group }) => (
      <span className="flex flex-col leading-tight">
        <span className="mono text-[12.5px]">{group.package}</span>
        <span className="text-[11px] text-dim">{group.ecosystem}</span>
      </span>
    ),
  },
  {
    id: 'version',
    header: 'Version → fixed in',
    cell: ({ group }) => {
      const versions = [...new Set(group.repos.flatMap((repo) => repo.versions))]
      return (
        <span className="mono whitespace-nowrap text-[12.5px]">
          {versions[0] ?? '—'}
          {versions.length > 1 ? <span className="text-dim"> +{versions.length - 1}</span> : null}
          <span className="text-dim"> → </span>
          {group.fixedIn[0] ? (
            <span className="text-ok">{group.fixedIn[0]}</span>
          ) : (
            <span className="text-muted">no fix</span>
          )}
        </span>
      )
    },
  },
  { id: 'repos', header: 'Repositories', cell: (row) => <RepoCell row={row} /> },
  {
    id: 'status',
    header: 'Status',
    cell: ({ group }) => (
      <span className="flex flex-col items-start gap-0.5">
        <Tag tone={findingStatusTone(group.status)} dot>
          {findingStatusLabel[group.status]}
        </Tag>
        {statusNote(group) ? (
          <span className="text-[11px] text-dim">{statusNote(group)}</span>
        ) : null}
      </span>
    ),
  },
  {
    id: 'seen',
    header: 'First seen',
    className: 'whitespace-nowrap',
    cell: ({ group }) => (
      <span title={formatDateTime(group.firstSeenAt)} className="text-muted">
        {formatRelative(group.firstSeenAt)}
      </span>
    ),
  },
  {
    id: 'open',
    header: <span className="sr-only">Open</span>,
    align: 'right',
    cell: () => <ChevronRight aria-hidden className="size-4 text-muted" />,
  },
]

function strip(rows: readonly FindingGroupRow[], narrowed: boolean): StripCell[] {
  const counts = findingCounts(rows.map((row) => row.group))
  return [
    {
      value: counts.groups,
      label: counts.groups === 1 ? 'finding' : 'findings',
      ...(narrowed ? {} : { caption: `in ${plural(counts.repos, 'repository', 'repositories')}` }),
    },
    ...severities
      .filter((severity) => severity !== 'unknown' || counts.severities.unknown > 0)
      .map((severity) => ({
        value: counts.severities[severity],
        label: severityLabel[severity].toLowerCase(),
        tone: counts.severities[severity] ? severityTone(severity) : ('none' as const),
      })),
    {
      value: counts.status.open,
      label: 'open',
      caption: `· ${counts.status.fixing} fixing · ${counts.status.allowlisted} allowlisted`,
      end: true,
    },
  ]
}

/**
 * The findings list of Supply › Security, or of one repository with `repo`: advisory and package
 * groups with severity, status, ecosystem and text filters, a sort, and the finding sheet.
 * `search` holds the filters and the open finding; `update` merges a change into it.
 */
export function FindingsBody({
  repo,
  search,
  update,
  pickRepo = false,
}: {
  repo?: RepoRef
  search: SecuritySearch
  update: (patch: Partial<SecuritySearch>) => void
  /** Offers a Repository filter that writes `repo`; the fleet page sets it. */
  pickRepo?: boolean
}) {
  const findings = useFindings(repo)
  const fleet = useFindings(undefined, pickRepo)
  const repoOptions = [
    ...new Set((fleet.data?.groups ?? []).flatMap((group) => group.repos.map((r) => r.repo))),
  ]
    .toSorted()
    .map((key) => ({ id: key, label: key }))
  const { view, setView, homeGroups } = useScope()
  const all = findings.data?.groups ?? []
  const sort = search.sort ?? 'severity'
  const groups = sortFindings(filterFindings(all, search), sort)
  const rows = findingRows(groups)
  const ecosystems = findingEcosystems(all)
  const keys = (
    view === 'mine' && !repo ? foldOtherTeams(rows, homeGroups, (row) => row.groups).mine : rows
  ).map((row) => row.key)
  const step = neighbours(keys, search.finding)
  const current = step.index >= 0 ? rows.find((row) => row.key === search.finding) : undefined
  const filtered = Boolean(
    search.q || search.severity?.length || search.status?.length || search.ecosystem?.length,
  )

  if (findings.isPending) return <Placeholder className="h-72" />
  if (findings.isError) return <ErrorState error={findings.error} />

  return (
    <>
      <FleetTable<FindingGroupRow>
        label="Findings"
        rows={rows}
        rowKey={(row) => row.key}
        columns={columns}
        {...(repo ? {} : { scope: { value: view, onChange: setView, homeGroups } })}
        strip={(shown) => strip(shown, repo !== undefined)}
        noun={{ one: 'finding', many: 'findings' }}
        caption="· grouped by advisory and package"
        onOpen={(row) => update({ finding: row.key, tab: undefined })}
        toolbar={
          <>
            {pickRepo ? (
              <FilterButton
                single
                label="Repository"
                options={repoOptions}
                value={repo ? [repoKey(repo)] : []}
                onChange={([key]) => update({ repo: key, finding: undefined })}
              />
            ) : null}
            <FilterButton
              label="Severity"
              options={severities.map((id) => ({ id, label: severityLabel[id] }))}
              value={search.severity ?? []}
              onChange={(severity) =>
                update({ severity: parseSecuritySearch({ severity }).severity })
              }
            />
            <FilterButton
              label="Status"
              options={statusOptions}
              value={search.status ?? []}
              onChange={(status) => update({ status: parseSecuritySearch({ status }).status })}
            />
            {ecosystems.length > 1 ? (
              <FilterButton
                label="Ecosystem"
                options={ecosystems.map((id) => ({ id, label: id }))}
                value={search.ecosystem ?? []}
                onChange={(ecosystem) =>
                  update({ ecosystem: ecosystem.length ? ecosystem : undefined })
                }
              />
            ) : null}
            <Select
              aria-label="Sort findings"
              className="w-44"
              options={sortOptions}
              value={sort}
              onChange={(id) => update({ sort: parseSecuritySearch({ sort: id }).sort })}
            />
          </>
        }
        empty={
          <EmptyState
            icon={<ShieldCheck />}
            title={filtered ? 'No finding matches' : 'No findings'}
            description={
              filtered
                ? 'Change or clear the filters to see more findings.'
                : 'The newest audit of every repository you can see reports nothing open.'
            }
          />
        }
      />
      <FindingSheet
        group={current?.group}
        tab={search.tab}
        onTab={(tab) => update({ tab })}
        onClose={() => update({ finding: undefined, tab: undefined })}
        {...(current ? { index: step.index, total: keys.length } : {})}
        {...(step.previous ? { onPrevious: () => update({ finding: step.previous }) } : {})}
        {...(step.next ? { onNext: () => update({ finding: step.next }) } : {})}
      />
    </>
  )
}
