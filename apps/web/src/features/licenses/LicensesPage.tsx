import type { LicensesOverview, LicensesRepoRow, RepoRef } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, Scale, X } from 'lucide-react'
import { useState } from 'react'

import { useLicenses } from '../../api/queries.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDate, formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import { foldOtherTeams } from '../../lib/home-scope.ts'
import {
  type LicenseKpis,
  type LicensesSearch,
  type LicensesSort,
  type ViolationRow,
  deltaText,
  filterLicenseRepos,
  filterViolations,
  licenseFileLabel,
  exceptedCount,
  licenseKpis,
  mixParts,
  parseLicensesSearch,
  policyFacts,
  sortViolations,
  verdictLabel,
  verdictTone,
  violationLicense,
  violationRows,
} from '../../lib/licenses.ts'
import { parseRepoKey, repoKey, repoSplat } from '../../lib/repo.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  type FleetColumn,
  FilterButton,
  FleetTable,
  KeyValue,
  Page,
  Placeholder,
  Select,
  Strip,
  type StripCell,
  Tag,
} from '../../ui/index.ts'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { useScope } from '../shell/scope.ts'
import { ViolationSheet } from './ViolationSheet.tsx'

const verdictOptions = (['denied', 'unlisted', 'unknown'] as const).map((id) => ({
  id,
  label: verdictLabel[id],
}))

const sortOptions: { id: LicensesSort; label: string }[] = [
  { id: 'verdict', label: 'Sort: Verdict' },
  { id: 'license', label: 'Sort: License' },
  { id: 'package', label: 'Sort: Package' },
  { id: 'repos', label: 'Sort: Repositories' },
]

function kpiCells(
  kpi: LicenseKpis,
  overview: LicensesOverview,
  mode: 'fleet' | 'mine' | 'repo',
): StripCell[] {
  const narrowed = mode === 'repo'
  const deltas = mode === 'fleet' ? overview.deltas : undefined
  const since = deltas ? ` since ${formatDate(deltas.since)}` : ''
  const caption = (text: string) => (text ? `${text}${since}` : undefined)
  return [
    {
      value: kpi.packages.toLocaleString('en'),
      label: 'packages checked',
      ...(narrowed
        ? {}
        : {
            caption: `in ${plural(kpi.repos, 'repository', 'repositories')}${mode === 'mine' ? ' of my teams' : ''}`,
          }),
    },
    {
      value: kpi.denied,
      label: 'denied',
      tone: kpi.denied ? 'danger' : 'none',
      ...(caption(deltaText(deltas?.denied))
        ? { caption: caption(deltaText(deltas?.denied)) }
        : {}),
    },
    {
      value: kpi.review,
      label: 'need review',
      tone: kpi.review ? 'warning' : 'none',
      ...(caption(deltaText(deltas?.review))
        ? { caption: caption(deltaText(deltas?.review)) }
        : {}),
    },
    {
      value: kpi.unknown,
      label: 'unknown license',
      tone: kpi.unknown ? 'warning' : 'none',
      ...(caption(deltaText(deltas?.unknown))
        ? { caption: caption(deltaText(deltas?.unknown)) }
        : {}),
    },
    {
      value: kpi.licenses,
      label: mode === 'fleet' ? 'distinct licenses' : 'licenses among violations',
      ...(mode === 'fleet' ? { caption: `${kpi.allowedLicenses} allowed by policy` } : {}),
    },
    {
      value: kpi.missingLicenseFile,
      label: narrowed ? 'license file missing' : 'repositories without a license file',
      tone: kpi.missingLicenseFile ? 'warning' : 'none',
    },
  ]
}

const mixShades = ['100%', '72%', '52%', '36%', '24%', '14%']

function Mix({
  overview,
  internal,
  fleet,
}: {
  overview: LicensesOverview
  internal: number
  fleet: boolean
}) {
  const parts = mixParts(overview.mix)
  if (!parts.length) return null
  const total = overview.mix.reduce((sum, entry) => sum + entry.packages, 0)
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-line bg-panel px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold">
          License mix across {total.toLocaleString('en')} packages
          {fleet ? <span className="font-normal text-muted"> · every repository</span> : null}
        </h2>
        {internal ? (
          <span className="text-xs text-muted">{internal} internal packages left out</span>
        ) : null}
      </div>
      <div
        role="img"
        aria-label={parts.map((part) => `${part.license} ${part.percent}%`).join(', ')}
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full"
      >
        {parts.map((part, index) => (
          <span
            key={part.license}
            className="h-full"
            style={{
              width: `${(part.packages / total) * 100}%`,
              background: `color-mix(in oklab, var(--fg) ${mixShades[index] ?? '10%'}, transparent)`,
            }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {parts.map((part, index) => (
          <li key={part.license} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-sm"
              style={{
                background: `color-mix(in oklab, var(--fg) ${mixShades[index] ?? '10%'}, transparent)`,
              }}
            />
            <span className="mono">{part.license}</span>
            <span className="tabular text-foreground">{part.percent}%</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function RepoLink({ repo, section }: { repo: string; section: 'licenses' }) {
  const ref = parseRepoKey(repo)
  if (!ref) return <span className="mono text-[12.5px]">{repo}</span>
  return (
    <Link
      to="/repos/$"
      params={{ _splat: repoSplat(ref) }}
      search={{ tab: 'supply', section }}
      className="mono truncate text-[12.5px] hover:underline"
    >
      {ref.path}
    </Link>
  )
}

const violationColumns: readonly FleetColumn<ViolationRow>[] = [
  {
    id: 'license',
    header: 'License',
    cell: ({ violation }) => (
      <span className="mono text-[12.5px]">{violationLicense(violation)}</span>
    ),
  },
  {
    id: 'verdict',
    header: 'Verdict',
    cell: ({ violation }) => (
      <Tag tone={verdictTone(violation.verdict)} dot>
        {verdictLabel[violation.verdict]}
      </Tag>
    ),
  },
  {
    id: 'package',
    header: 'Package',
    cell: ({ violation }) => (
      <span className="flex flex-col leading-tight">
        <span className="mono text-[12.5px]">
          {violation.package}
          {violation.versions[0] ? (
            <span className="text-dim"> {violation.versions[0]}</span>
          ) : null}
        </span>
        <span className="text-[11px] text-dim">
          {violation.ecosystem}
          {violation.dev ? ' · dev only' : ''}
        </span>
      </span>
    ),
  },
  {
    id: 'repos',
    header: 'Repositories',
    cell: ({ violation }) => {
      const [first, ...rest] = violation.repos
      if (!first) return null
      return (
        <span className="flex flex-col leading-tight">
          <RepoLink repo={first.repo} section="licenses" />
          {rest.length ? <span className="text-[11px] text-dim">+{rest.length} more</span> : null}
        </span>
      )
    },
  },
  {
    id: 'rule',
    header: 'Policy rule',
    cell: ({ violation }) =>
      violation.culprits.length ? (
        <span className="mono text-[12.5px] text-muted">{violation.culprits.join(', ')}</span>
      ) : (
        <span className="text-muted">
          {violation.verdict === 'unknown' ? 'Unknown license' : 'Not allowed'}
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

const count = (value: number, tone: 'danger' | 'warning' | 'default') =>
  value ? (
    <Tag tone={tone} dot>
      {value}
    </Tag>
  ) : (
    <span className="tabular text-dim">0</span>
  )

const repoColumns: readonly FleetColumn<LicensesRepoRow>[] = [
  {
    id: 'repo',
    header: 'Repository',
    className: 'min-w-56',
    cell: (row) => <RepoLink repo={row.repo} section="licenses" />,
  },
  {
    id: 'group',
    header: 'Group',
    cell: (row) => (
      <span className="flex flex-wrap gap-1">
        {row.groups.map((group) => (
          <Tag key={group}>{group}</Tag>
        ))}
      </span>
    ),
  },
  {
    id: 'packages',
    header: 'Packages',
    align: 'right',
    cell: (row) => <span className="tabular">{row.packages.toLocaleString('en')}</span>,
  },
  { id: 'denied', header: 'Denied', cell: (row) => count(row.verdicts.denied, 'danger') },
  { id: 'review', header: 'Review', cell: (row) => count(row.verdicts.unlisted, 'warning') },
  { id: 'unknown', header: 'Unknown', cell: (row) => count(row.verdicts.unknown, 'warning') },
  { id: 'excepted', header: 'Excepted', cell: (row) => count(exceptedCount(row), 'default') },
  {
    id: 'file',
    header: 'License file',
    cell: (row) => (
      <Tag
        tone={
          row.licenseFile === 'missing'
            ? 'warning'
            : row.licenseFile === 'present'
              ? 'success'
              : 'default'
        }
        dot
      >
        {licenseFileLabel[row.licenseFile]}
      </Tag>
    ),
  },
  {
    id: 'scan',
    header: 'Last scan',
    className: 'whitespace-nowrap',
    cell: (row) => (
      <span title={formatDateTime(row.createdAt)} className="text-muted">
        {formatRelative(row.createdAt)}
      </span>
    ),
  },
  {
    id: 'record',
    header: <span className="sr-only">Record</span>,
    align: 'right',
    cell: (row) => (
      <Link
        to="/analyses/$id"
        params={{ id: row.analysisId }}
        className="text-xs text-muted hover:text-foreground"
      >
        Record
      </Link>
    ),
  },
]

function PolicySummary({
  overview,
  onEdit,
}: {
  overview: LicensesOverview
  onEdit: (() => void) | undefined
}) {
  const { policy } = overview
  if (!policy) return null
  const changed = policy.updatedAt
    ? `${formatDate(policy.updatedAt)}${policy.updatedBy ? ` by ${policy.updatedBy}` : ''}`
    : undefined
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">License policy</h2>
        {onEdit ? (
          <Button size="sm" variant="ghost" onPress={onEdit}>
            Edit
          </Button>
        ) : null}
      </div>
      <KeyValue
        rows={[...policyFacts(policy), ...(changed ? [{ label: 'Changed', value: changed }] : [])]}
      />
      {policy.deny.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          Denied
          {policy.deny.map((pattern) => (
            <Tag key={pattern} tone="danger" mono>
              {pattern}
            </Tag>
          ))}
        </div>
      ) : null}
      {policy.review.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          Needs review
          {policy.review.map((pattern) => (
            <Tag key={pattern} tone="warning" mono>
              {pattern}
            </Tag>
          ))}
        </div>
      ) : null}
      {policy.allow.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          Allowed
          {policy.allow.map((pattern) => (
            <Tag key={pattern} mono>
              {pattern}
            </Tag>
          ))}
        </div>
      ) : null}
      {policy.exceptions.length ? (
        <ul className="flex flex-col gap-1 text-xs">
          {policy.exceptions.map((exception) => (
            <li
              key={`${exception.package}@${exception.version ?? ''}`}
              className="flex flex-wrap items-baseline gap-1.5"
            >
              <Tag mono>
                {exception.package}
                {exception.version ? `@${exception.version}` : ''}
              </Tag>
              {exception.license ? (
                <span className="mono text-muted">{exception.license}</span>
              ) : null}
              <span className="min-w-0 flex-1">{exception.reason}</span>
              {exception.expires ? (
                <span className="mono text-muted">until {exception.expires}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted">
        Anything not on the allow list{policy.review.length ? ', or on the review list,' : ''} needs
        review; unknown licenses count as {policy.unknown === 'violation' ? 'violations' : 'review'}
        {policy.exceptions.length ? '; exceptions pass with their reason' : ''}.
      </p>
    </section>
  )
}

/**
 * The Licenses body over `GET /api/licenses`, or one repository's part of it with `repo`: KPI
 * strip with weekly deltas, license mix, violations with filters, sort and a side sheet, a row per
 * repository and the policy summary. `search` holds the filters and the open violation.
 */
function LicensesBody({
  repo,
  search,
  update,
  onEditPolicy,
}: {
  repo?: RepoRef
  search: LicensesSearch
  update: (patch: Partial<LicensesSearch>) => void
  onEditPolicy?: () => void
}) {
  const licenses = useLicenses()
  const navigate = useNavigate()
  const { view, setView, homeGroups } = useScope()
  if (licenses.isPending) return <Placeholder className="h-72" />
  if (licenses.isError) return <ErrorState error={licenses.error} />

  const overview = licenses.data
  const key = repo ? repoKey(repo) : search.repo
  const narrowed = repo !== undefined
  const filters = { ...search, ...(key ? { repo: key } : {}) }
  const sort = search.sort ?? 'verdict'
  const rows = violationRows(sortViolations(filterViolations(overview.violations, filters), sort))
  const repoRows = filterLicenseRepos(overview.repos, filters)
  const ecosystems = [...new Set(overview.violations.map((v) => v.ecosystem))].toSorted()
  const groups = [...new Set(overview.repos.flatMap((r) => r.groups))].toSorted()
  const mine = !narrowed && view === 'mine'
  const keys = (mine ? foldOtherTeams(rows, homeGroups, (row) => row.groups).mine : rows).map(
    (row) => row.key,
  )
  const step = neighbours(keys, search.package)
  const current = step.index >= 0 ? rows.find((row) => row.key === search.package) : undefined
  const kpi = key
    ? licenseKpis(overview, [key])
    : mine
      ? licenseKpis(
          overview,
          foldOtherTeams(overview.repos, homeGroups, (row) => row.groups).mine.map(
            (row) => row.repo,
          ),
        )
      : licenseKpis(overview)
  const filtered = Boolean(
    search.q || search.verdict?.length || search.ecosystem?.length || search.group?.length,
  )
  const scope = narrowed ? {} : { scope: { value: view, onChange: setView, homeGroups } }

  if (!overview.repos.length)
    return (
      <EmptyState
        icon={<Scale />}
        title="No license scans yet"
        description="Repositories show up once the licenses analyzer has run on them."
      />
    )
  if (narrowed && !overview.repos.some((row) => row.repo === key))
    return (
      <EmptyState
        icon={<Scale />}
        title="Not scanned yet"
        description="The licenses analyzer has not run on this repository yet."
      />
    )

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <Strip
          label="License totals"
          cells={kpiCells(kpi, overview, key ? 'repo' : mine ? 'mine' : 'fleet')}
          className="border-b-0"
        />
      </div>
      {key ? null : <Mix overview={overview} internal={overview.kpi.internal} fleet={mine} />}
      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold">
          Violations{' '}
          <span className="font-normal text-muted">
            · packages whose license the policy denies or wants reviewed
          </span>
        </h2>
        <FleetTable<ViolationRow>
          label="License violations"
          rows={rows}
          rowKey={(row) => row.key}
          columns={violationColumns}
          {...scope}
          noun={{ one: 'violation', many: 'violations' }}
          onOpen={(row) => update({ package: row.key, tab: undefined })}
          toolbar={
            <>
              <FilterButton
                label="Verdict"
                options={verdictOptions}
                value={search.verdict ?? []}
                onChange={(verdict) =>
                  update({ verdict: parseLicensesSearch({ verdict }).verdict })
                }
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
              {!narrowed && groups.length > 1 ? (
                <FilterButton
                  label="Group"
                  options={groups.map((id) => ({ id, label: id }))}
                  value={search.group ?? []}
                  onChange={(group) => update({ group: group.length ? group : undefined })}
                />
              ) : null}
              <Select
                aria-label="Sort violations"
                className="w-44"
                options={sortOptions}
                value={sort}
                onChange={(id) => update({ sort: parseLicensesSearch({ sort: id }).sort })}
              />
            </>
          }
          empty={
            <EmptyState
              icon={<Scale />}
              title={filtered ? 'No violation matches' : 'No violations'}
              description={
                filtered
                  ? 'Change or clear the filters to see more.'
                  : 'Every license the policy covers is allowed.'
              }
            />
          }
        />
      </section>
      {narrowed ? null : (
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-semibold">
            By repository{' '}
            <span className="font-normal text-muted">
              · newest scan per repository; rows open its Supply chain tab
            </span>
          </h2>
          <FleetTable<LicensesRepoRow>
            label="License scans by repository"
            rows={repoRows}
            rowKey={(row) => row.repo}
            columns={repoColumns}
            {...scope}
            onOpen={(row) => {
              const ref = parseRepoKey(row.repo)
              if (ref)
                void navigate({
                  to: '/repos/$',
                  params: { _splat: repoSplat(ref) },
                  search: { tab: 'supply', section: 'licenses' },
                })
            }}
          />
        </section>
      )}
      <PolicySummary overview={overview} onEdit={onEditPolicy} />
      <ViolationSheet
        violation={current?.violation}
        policy={overview.policy}
        tab={search.tab}
        onTab={(tab) => update({ tab })}
        onClose={() => update({ package: undefined, tab: undefined })}
        {...(current ? { index: step.index, total: keys.length } : {})}
        {...(step.previous ? { onPrevious: () => update({ package: step.previous }) } : {})}
        {...(step.next ? { onNext: () => update({ package: step.next }) } : {})}
      />
    </div>
  )
}

const merge = (prev: LicensesSearch, patch: Partial<LicensesSearch>): LicensesSearch =>
  Object.fromEntries(
    Object.entries({ ...prev, ...patch }).filter(([, value]) => value !== undefined),
  )

/** Supply › Licenses: license verdicts of the newest scan of every repository you can see. */
export function LicensesPage() {
  const search = useSearch({ from: '/app/supply/licenses' })
  const navigate = useNavigate({ from: '/supply/licenses' })
  const update = (patch: Partial<LicensesSearch>) =>
    void navigate({ search: (prev) => merge(prev, patch), replace: true })
  const repo = parseRepoKey(search.repo)
  const settings = useConfigure('License settings', pageSettingKeys.licenses)
  const run = useRunJob({
    analyzer: 'licenses',
    label: 'Run license scan',
    ...(repo ? { repo } : {}),
  })
  return (
    <Page
      crumbs={[{ label: 'Licenses' }]}
      description={
        repo
          ? `License verdicts of ${repoKey(repo)}`
          : 'License verdicts of the newest scan of every repository you can see'
      }
      search={{
        value: search.q ?? '',
        onChange: (q) => update({ q: q || undefined }),
        'aria-label': 'Filter licenses',
        placeholder: 'Package, license or repository',
      }}
      {...(repo
        ? {
            filters: (
              <Button size="sm" variant="secondary" onPress={() => update({ repo: undefined })}>
                Repository: <span className="mono">{repo.path}</span>
                <X aria-label="Clear repository" className="size-3.5" />
              </Button>
            ),
          }
        : {})}
      configure={settings.configure}
      primary={run.action}
    >
      <LicensesBody
        search={search}
        update={update}
        {...(settings.configure ? { onEditPolicy: settings.configure.onPress } : {})}
      />
      {settings.sheet}
      {run.dialog}
    </Page>
  )
}

/** The Licenses body narrowed to one repository, for the repository hub's Supply chain tab. */
export function RepoLicenses({ repo }: { repo: RepoRef }) {
  const [search, setSearch] = useState<LicensesSearch>({})
  return (
    <LicensesBody
      repo={repo}
      search={search}
      update={(patch) => setSearch((prev) => merge(prev, patch))}
    />
  )
}
