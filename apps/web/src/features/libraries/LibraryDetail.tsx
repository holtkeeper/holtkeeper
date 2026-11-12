import {
  type DependencyDecision,
  type DependencyDetail,
  type DependencyRow,
  type DependencyUpgrade,
  type PublicApiPackageDetail,
  formatBytes,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ExternalLink, FileText, Search } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import {
  useDependency,
  useDependencyApi,
  useDependencyDocs,
  useGroupTitles,
  usePublicApiPackage,
  useWriteTasks,
} from '../../api/queries.ts'
import {
  type LibrarySearch,
  type LibraryTab,
  apiChangeLabel,
  behindLabel,
  behindTone,
  mergeRequestStatusLabel,
} from '../../lib/dependencies.ts'
import { formatDate, formatRelative, plural } from '../../lib/format.ts'
import { foldOtherTeams } from '../../lib/home-scope.ts'
import {
  excerpt,
  formatRoles,
  groupDocuments,
  headingPath,
  librarySearchQuery,
} from '../../lib/libraries.ts'
import { parseVerdict, verdictLabel, verdictTone } from '../../lib/licenses.ts'
import { documentedShare } from '../../lib/public-api.ts'
import { repoKey, repoSplat } from '../../lib/repo.ts'
import { taskGroupCap } from '../../lib/tasks.ts'
import { httpUrl } from '../../lib/url.ts'
import { impactLabel, impactTone, memberLabel } from '../../lib/usages.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import {
  CopyButton,
  EmptyState,
  ErrorState,
  KeyValue,
  type KeyValueRow,
  Markdown,
  Notice,
  OtherTeams,
  Placeholder,
  SearchInput,
  SegmentBar,
  Select,
  SeverityChip,
  Tag,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { ApiSummary, ApiTab } from './ApiTab.tsx'
import { ChangesTab, ReleaseNotes } from './ChangesTab.tsx'
import { useFoldedUsers, useUpgradePlan } from './upgrade-plan.ts'
import { UsedByTab } from './UsedByTab.tsx'

type Library = { ecosystem: DependencyRow['ecosystem']; name: string }

/** What a library's tabs keep between renders: the URL on its page, local state in the sheet. */
export type LibraryState = Omit<LibrarySearch, 'tab'>

function Section({
  title,
  actions,
  children,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-[11.5px] font-medium text-muted">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

/**
 * One tab of a library. The tab bar belongs to the caller: the side sheet's tabs or the page's.
 * `state` carries the picks the tabs share (API version, upgrade ends, Used by narrowing);
 * `onState` merges a change into it. `inSheet` adds the facts the library page shows in its
 * header (latest version, description) to the Overview.
 */
export function LibraryDetail({
  library,
  tab,
  state,
  onState,
  inSheet = false,
}: {
  library: Library
  tab: LibraryTab
  state: LibraryState
  onState: (next: LibraryState) => void
  inSheet?: boolean
}) {
  const detail = useDependency(library)
  if (detail.isPending) return <Placeholder className="h-72" />
  if (detail.isError) return <ErrorState error={detail.error} />
  switch (tab) {
    case 'api':
    case 'changes':
      return <ApiTabs detail={detail.data} tab={tab} state={state} onState={onState} />
    case 'used-by':
      return <LibraryUsedBy detail={detail.data} state={state} onState={onState} />
    case 'upgrade':
      return <UpgradeTab detail={detail.data} state={state} onState={onState} />
    case 'docs':
      return <DocsTab detail={detail.data} />
    default:
      return <OverviewTab detail={detail.data} inSheet={inSheet} />
  }
}

function ApiTabs({
  detail,
  tab,
  state,
  onState,
}: {
  detail: DependencyDetail
  tab: 'api' | 'changes'
  state: LibraryState
  onState: (next: LibraryState) => void
}) {
  const api = useDependencyApi(detail)
  if (api.isPending) return <Placeholder className="h-72" />
  if (api.isError) return <ErrorState error={api.error} />
  const definedIn = api.data.definedIn
  if (!definedIn)
    return tab === 'api' ? <ApiSummary api={api.data} /> : <ReleaseNotes detail={detail} />
  return (
    <InternalPackage
      name={detail.name}
      repo={repoKey(definedIn.repo)}
      {...(state.version ? { version: state.version } : {})}
    >
      {(data) =>
        tab === 'api' ? (
          <ApiTab data={data} onVersion={(version) => onState({ ...state, version })} />
        ) : (
          <ChangesTab key={data.analysisId} data={data} />
        )
      }
    </InternalPackage>
  )
}

function InternalPackage({
  name,
  repo,
  version,
  children,
}: {
  name: string
  repo: string
  version?: string
  children: (data: PublicApiPackageDetail) => ReactNode
}) {
  const pkg = usePublicApiPackage({ name, repo, ...(version ? { version } : {}) })
  if (pkg.isPending) return <Placeholder className="h-72" />
  if (pkg.isError) return <ErrorState error={pkg.error} />
  return children(pkg.data)
}

function LibraryUsedBy({
  detail,
  state,
  onState,
}: {
  detail: DependencyDetail
  state: LibraryState
  onState: (next: LibraryState) => void
}) {
  const api = useDependencyApi(detail, detail.internal && detail.ecosystem === 'npm')
  const props = {
    detail,
    repo: state.repo,
    exportName: state.export,
    using: state.using,
    onRepo: (repo: string | undefined) => onState({ ...state, repo, export: undefined }),
    onExport: (name: string | undefined) => onState({ ...state, export: name }),
    onUsing: (using: string | undefined) => onState({ ...state, using }),
  }
  const definedIn = api.data?.definedIn
  if (!definedIn) return <UsedByTab {...props} />
  return (
    <InternalPackage name={detail.name} repo={repoKey(definedIn.repo)}>
      {(data) => <UsedByTab {...props} entries={data.package.entries} />}
    </InternalPackage>
  )
}

function ExternalLinks({ detail }: { detail: DependencyDetail }) {
  const links = [
    { label: 'homepage', url: httpUrl(detail.homepage) },
    { label: 'repository', url: httpUrl(detail.repository) },
  ].filter((link) => link.url)
  if (!links.length) return null
  return (
    <span className="flex flex-wrap items-center gap-3">
      {links.map((link) => (
        <a
          key={link.label}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="text-muted hover:text-foreground"
        >
          <ExternalLink className="mr-1 inline size-3" />
          {link.label}
        </a>
      ))}
    </span>
  )
}

function Facts({
  detail,
  extra = [],
}: {
  detail: DependencyDetail
  extra?: readonly KeyValueRow[]
}) {
  return (
    <KeyValue
      rows={[
        {
          label: 'Latest',
          value: (
            <span>
              <span className="mono">{detail.latest ?? '—'}</span>
              {detail.latestCheckedAt ? (
                <span className="text-muted">
                  {' '}
                  · checked {formatRelative(detail.latestCheckedAt)}
                </span>
              ) : null}
            </span>
          ),
        },
        { label: 'Ecosystem', value: <span className="mono">{detail.ecosystem}</span> },
        { label: 'Internal', value: detail.internal ? 'Yes' : null },
        {
          label: 'License',
          value: detail.licenses.length
            ? [...new Set(detail.licenses.flatMap((entry) => entry.licenses))].join(', ') ||
              'Unknown'
            : null,
        },
        { label: 'Links', value: <ExternalLinks detail={detail} /> },
        { label: 'Description', value: detail.description },
        ...extra,
      ]}
    />
  )
}

const impactLevels = ['breaking', 'check', 'deprecated'] as const

/** The sheet's facts plus what an upgrade and agents would meet: API docs, readiness, task caps. */
function SheetFacts({ detail }: { detail: DependencyDetail }) {
  const { can } = useSession()
  const api = useDependencyApi(detail)
  const plan = useUpgradePlan(detail, {})
  const write = useWriteTasks(can('tasks:run'))
  const exports = api.data?.api
  const share = exports ? documentedShare(exports.documented, exports.exports) : undefined
  const onTarget = plan.to
    ? detail.usedBy.filter((user) => user.versions.includes(plan.to!)).length
    : 0
  const levels = impactLevels.flatMap((level) => {
    const count = (plan.impact?.items ?? []).filter((item) => item.level === level).length
    return count ? [`${count} ${impactLabel[level].toLowerCase()}`] : []
  })
  const cap = write.data ? taskGroupCap(write.data, 1) : undefined
  return (
    <Facts
      detail={detail}
      extra={[
        {
          label: 'Public API',
          value: exports ? (
            <span>
              <span className="mono">{exports.exports}</span> exports
              {share === undefined ? null : (
                <span className="text-muted"> · {share}% documented</span>
              )}
            </span>
          ) : null,
        },
        {
          label: 'Upgrade readiness',
          value:
            plan.to && detail.usedBy.length ? (
              <span>
                {plan.from && plan.from !== plan.to ? (
                  <span className="mono">
                    {plan.from} → {plan.to}
                  </span>
                ) : (
                  <span className="mono">{plan.to}</span>
                )}
                <span className="text-muted">
                  {' '}
                  · {onTarget} of {detail.usedBy.length} on it
                  {levels.length ? ` · ${levels.join(', ')}` : ''}
                </span>
              </span>
            ) : null,
        },
        {
          label: 'Write tasks',
          value: write.data ? (
            <span>
              {write.data.enabled ? 'On' : 'Off'}
              {cap ? (
                <span className="text-muted">
                  {' '}
                  · cap <span className="mono">${cap.perRepo.toFixed(2)}</span> per repository
                </span>
              ) : null}
            </span>
          ) : null,
        },
      ]}
    />
  )
}

function DecisionList({ decisions }: { decisions: readonly DependencyDecision[] }) {
  const titleOf = useGroupTitles()
  if (!decisions.length) return null
  return (
    <ul className="flex flex-col gap-1.5">
      {decisions.map((decision) => (
        <li key={decision.id} className="flex flex-wrap items-center gap-2 text-sm">
          <Tag tone={decision.source === 'human' ? 'accent' : 'info'}>{decision.kind}</Tag>
          <Link
            to="/knowledge/notes"
            search={{}}
            className="min-w-0 flex-1 truncate hover:underline"
          >
            {decision.title}
          </Link>
          {decision.shared && decision.owner.length ? (
            <Tag>{decision.owner.map(titleOf).join(', ')}</Tag>
          ) : null}
          <span className="text-xs text-muted">
            {decision.source === 'agent' ? 'agent, approved' : decision.author} ·{' '}
            {formatRelative(decision.updatedAt)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function OverviewTab({ detail, inSheet }: { detail: DependencyDetail; inSheet: boolean }) {
  const users = useFoldedUsers(detail.usedBy)
  const { homeGroups } = useScope()
  const decisions = foldOtherTeams(detail.decisions, homeGroups, (decision) =>
    decision.shared ? decision.owner : [],
  )
  const sorted = users.shown.toSorted((a, b) => b.majorsBehind - a.majorsBehind)
  return (
    <div className="flex flex-col gap-5">
      {inSheet ? <SheetFacts detail={detail} /> : <ExternalLinks detail={detail} />}

      {detail.decisions.length ? (
        <Section title="Team decisions">
          <DecisionList decisions={decisions.mine} />
          <OtherTeams count={decisions.others.length} teams={decisions.teams}>
            <DecisionList decisions={decisions.others} />
          </OtherTeams>
        </Section>
      ) : null}

      <Section title="Versions in use">
        <SegmentBar
          segments={detail.versions.map((entry) => ({
            value: entry.repos,
            tone: behindTone(entry.majorsBehind),
            label: `on ${entry.version}`,
          }))}
        />
        <div className="flex flex-wrap gap-1.5">
          {detail.versions.map((entry) => (
            <Tag key={entry.version} tone={behindTone(entry.majorsBehind)} mono>
              {entry.version} × {entry.repos}
            </Tag>
          ))}
        </div>
      </Section>

      <Section
        title={`Used by ${plural(detail.usedBy.length, 'repository', 'repositories')}`}
        actions={
          users.folded ? (
            <button
              type="button"
              className="text-xs text-muted hover:text-foreground"
              onClick={users.toggle}
            >
              {users.expanded ? 'Fold other teams' : 'Show other teams'}
            </button>
          ) : null
        }
      >
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
          {sorted.map((user) => (
            <li
              key={repoKey(user.repo)}
              className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
            >
              <Link
                to="/repos/$"
                params={{ _splat: repoSplat(user.repo) }}
                className="mono min-w-0 flex-1 truncate text-[12.5px] hover:underline"
              >
                {user.repo.path}
              </Link>
              <span className="mono text-xs">{user.versions.join(', ')}</span>
              <Tag tone={behindTone(user.majorsBehind)}>{behindLabel(user.majorsBehind)}</Tag>
            </li>
          ))}
          {users.folded && !users.expanded ? (
            <li className="px-3 py-2 text-xs text-muted">
              Used in {plural(users.folded.items, 'repo')} of{' '}
              {plural(users.folded.teams, 'other team')}
            </li>
          ) : null}
        </ul>
      </Section>

      {detail.advisories.length ? (
        <Section title="Advisories">
          <ul className="flex flex-col gap-2">
            {detail.advisories.map((advisory) => {
              const url = httpUrl(advisory.url)
              return (
                <li
                  key={advisory.id}
                  className="flex flex-col gap-1 rounded-xl border border-line p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityChip severity={advisory.severity} compact />
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="mono text-xs hover:underline"
                      >
                        {advisory.id}
                      </a>
                    ) : (
                      <span className="mono text-xs">{advisory.id}</span>
                    )}
                    <span className="text-xs text-muted">
                      {advisory.versions.join(', ')}
                      {advisory.fixedVersions.length
                        ? ` · fixed in ${advisory.fixedVersions.join(', ')}`
                        : ''}
                    </span>
                  </div>
                  <p>{advisory.summary}</p>
                  <p className="text-xs text-muted">
                    {plural(advisory.repos.length, 'repository', 'repositories')}
                  </p>
                </li>
              )
            })}
          </ul>
        </Section>
      ) : null}

      {detail.licenses.length ? (
        <Section title="Licenses">
          <ul className="flex flex-col gap-1 text-sm">
            {detail.licenses.map((license) => (
              <li key={license.version} className="flex flex-wrap items-center gap-2">
                <span className="mono text-xs">{license.version}</span>
                <span>{license.licenses.join(', ') || 'unknown'}</span>
                {license.verdicts.map((verdict) => {
                  const name = parseVerdict(verdict.verdict)
                  return (
                    <Tag
                      key={verdict.verdict}
                      tone={name ? verdictTone(name) : 'default'}
                      title={verdict.repos.join(', ')}
                    >
                      {name ? verdictLabel[name] : verdict.verdict} · {verdict.repos.length}
                    </Tag>
                  )
                })}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {detail.bundles.length ? (
        <Section title="Bundle share">
          <ul className="flex flex-col gap-1 text-sm">
            {detail.bundles.map((bundle) => (
              <li
                key={`${bundle.repo} ${bundle.target}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="mono text-[12.5px]">{bundle.repo}</span>{' '}
                  <span className="text-muted">{bundle.target}</span>
                </span>
                <span className="mono text-xs">
                  {formatBytes(bundle.gzip)}
                  {bundle.total ? ` of ${formatBytes(bundle.total)}` : ''} gzip
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <MergeRequests detail={detail} />

      {detail.indexed.length ? (
        <Section title="Indexed versions">
          <div className="flex flex-wrap gap-1.5">
            {detail.indexed.map((entry) => (
              <Tag
                key={entry.version}
                mono
                tone={entry.deprecated ? 'warning' : 'default'}
                title={[
                  ...formatRoles(entry.roles).map((role) => role.label),
                  ...(entry.publishedAt ? [`published ${formatDate(entry.publishedAt)}`] : []),
                  ...(entry.deprecated ? [`deprecated: ${entry.deprecated}`] : []),
                ].join(' · ')}
              >
                {entry.version}
              </Tag>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  )
}

function MergeRequests({ detail }: { detail: DependencyDetail }) {
  if (!detail.mergeRequests.length) return null
  return (
    <Section title="Update merge requests">
      <ul className="flex flex-col gap-1 text-sm">
        {detail.mergeRequests.map((mr) => {
          const url = httpUrl(mr.url)
          return (
            <li key={`${mr.repo} ${mr.id}`} className="flex flex-wrap items-center gap-2">
              <Tag tone={mr.status === 'broken' ? 'danger' : 'default'}>
                {mergeRequestStatusLabel[mr.status]}
              </Tag>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate hover:underline"
                >
                  {mr.title}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate">{mr.title}</span>
              )}
              <span className="mono text-[12.5px] text-muted">{mr.repo}</span>
              {mr.next ? <span className="mono text-xs">→ {mr.next}</span> : null}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

function UpgradeTab({
  detail,
  state,
  onState,
}: {
  detail: DependencyDetail
  state: LibraryState
  onState: (next: LibraryState) => void
}) {
  const plan = useUpgradePlan(detail, {
    ...(state.from ? { from: state.from } : {}),
    ...(state.to ? { to: state.to } : {}),
  })
  const { options, data, users } = plan
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label="From"
          className="w-40"
          value={plan.from}
          onChange={(from) => onState({ ...state, from })}
          options={options.from.map((version) => ({ id: version, label: version }))}
        />
        <Select
          label="To"
          className="w-40"
          value={plan.to}
          onChange={(to) => onState({ ...state, to })}
          options={options.to.map((version) => ({
            id: version,
            label: version === detail.latest ? `${version} (latest)` : version,
            text: version,
          }))}
        />
        <div className="ml-auto flex gap-2">
          <CopyButton isDisabled={!data} text={plan.prompt}>
            Copy as prompt
          </CopyButton>
        </div>
      </div>
      {users.folded && !users.expanded ? (
        <p className="text-xs text-muted">
          Uses in {plural(users.folded.items, 'repo')} of {plural(users.folded.teams, 'other team')}{' '}
          are left out.{' '}
          <button type="button" className="text-foreground hover:underline" onClick={users.toggle}>
            Include them
          </button>
        </p>
      ) : null}

      {plan.upgrade.isPending && (plan.from || plan.to) ? (
        <Placeholder className="h-48" />
      ) : plan.upgrade.isError ? (
        <ErrorState error={plan.upgrade.error} />
      ) : data ? (
        <UpgradeBody data={data} impact={plan.impact} />
      ) : (
        <EmptyState
          title="No version to compare"
          description="No version of this library is in use or indexed."
        />
      )}
      <MergeRequests detail={detail} />
    </div>
  )
}

function UpgradeBody({
  data,
  impact,
}: {
  data: DependencyUpgrade
  impact: DependencyUpgrade['impact']
}) {
  return (
    <>
      {data.notes.length ? (
        <Notice tone="default" title="Not everything is known">
          <ul className="list-disc pl-4">
            {data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {impact ? (
        <Section title="Affected uses">
          {impact.items.length ? (
            <ul className="flex flex-col gap-2">
              {impact.items.map((item) => (
                <li
                  key={`${item.change.change} ${item.change.subpath} ${item.change.name}`}
                  className="flex flex-col gap-1.5 rounded-xl border border-line p-3"
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Tag tone={impactTone[item.level]}>{impactLabel[item.level]}</Tag>
                    <span className="text-muted">{apiChangeLabel[item.change.change]}</span>
                    <span className="mono font-medium">{item.change.name}</span>
                    <span className="ml-auto text-xs text-muted">
                      {plural(item.count, 'use')} in {plural(item.repos.length, 'repo')}
                    </span>
                  </div>
                  {item.repos.map((repo) => (
                    <div
                      key={repo.origin}
                      className="flex flex-col gap-0.5 border-l border-line pl-3 text-xs"
                    >
                      <span className="font-medium">
                        {repo.origin}
                        {repo.via ? <span className="text-muted"> through {repo.via}</span> : null}
                      </span>
                      {repo.sites.map((site) => (
                        <span
                          key={`${site.file} ${site.line} ${site.column}`}
                          className="mono text-muted"
                        >
                          {site.file}:{site.line}
                          {site.member ? ` ${memberLabel(site.member)}` : ''}
                        </span>
                      ))}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No analyzed use is affected by these changes.</p>
          )}
        </Section>
      ) : null}
      {!impact && data.api?.length ? (
        <Section title="API changes">
          <ul className="flex flex-col gap-1 text-sm">
            {data.api.map((change) => (
              <li
                key={`${change.change} ${change.subpath} ${change.name}`}
                className="flex items-center gap-2"
              >
                <Tag tone={change.change === 'removed' ? 'danger' : 'warning'}>
                  {apiChangeLabel[change.change]}
                </Tag>
                <span className="mono">{change.name}</span>
                {change.subpath !== '.' ? (
                  <span className="mono text-xs text-muted">{change.subpath}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {data.changes ? (
        <Section title={`Changes ${data.from ?? ''} → ${data.to ?? ''}`}>
          <div className="rounded-xl border border-line bg-raise p-3">
            <Markdown text={data.changes} />
          </div>
        </Section>
      ) : null}
    </>
  )
}

function DocsTab({ detail }: { detail: DependencyDetail }) {
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 300)
  const results = useDependencyDocs(
    librarySearchQuery({
      q: debounced,
      ecosystem: detail.ecosystem,
      name: detail.name,
      ...(detail.docs.version ? { version: detail.docs.version } : {}),
      limit: 20,
    }),
  )
  const groups = groupDocuments(detail.docs.documents)
  return (
    <div className="flex flex-col gap-5">
      <SearchInput
        aria-label="Search the docs"
        placeholder={`Search ${detail.name} docs`}
        value={query}
        onChange={setQuery}
      />
      {debounced.trim() ? (
        results.isPending ? (
          <Placeholder className="h-40" />
        ) : results.isError ? (
          <ErrorState error={results.error} />
        ) : results.data.hits.length ? (
          <ul className="flex flex-col gap-2">
            {results.data.hits.map(({ chunk }) => {
              const url = httpUrl(chunk.url)
              return (
                <li
                  key={chunk.id}
                  className="flex flex-col gap-1 rounded-xl border border-line p-3"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="mono">{chunk.path}</span>
                    <span>{chunk.versions[0]}</span>
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-foreground"
                      >
                        <ExternalLink className="inline size-3" />
                      </a>
                    ) : null}
                  </div>
                  <span className="text-sm font-medium">{headingPath(chunk.headings)}</span>
                  <p className="text-sm text-muted">{excerpt(chunk.text)}</p>
                </li>
              )
            })}
          </ul>
        ) : (
          <EmptyState icon={<Search />} title="Nothing matches" description="Try other words." />
        )
      ) : groups.length ? (
        <Section title={`Documents${detail.docs.version ? ` of ${detail.docs.version}` : ''}`}>
          {groups.map((group) => (
            <div key={group.source} className="flex flex-col gap-1">
              <span className="text-xs text-muted">{group.label}</span>
              <ul className="flex flex-col gap-0.5 text-sm">
                {group.documents.map((doc) => (
                  <li key={doc.path} className="flex items-center gap-2">
                    <FileText className="size-3.5 shrink-0 text-muted" />
                    <span className="mono min-w-0 flex-1 truncate text-xs">{doc.path}</span>
                    <span className="text-xs text-muted">{plural(doc.chunks, 'section')}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>
      ) : (
        <EmptyState
          icon={<FileText />}
          title="No docs indexed"
          description="The library index fetches docs once library indexing is on in the settings."
        />
      )}
    </div>
  )
}
