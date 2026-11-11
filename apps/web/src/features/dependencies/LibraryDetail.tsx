import {
  type DependencyDecision,
  type DependencyDetail,
  type DependencyRow,
  type DependencyUpgrade,
  formatBytes,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ExternalLink, FileText, Search } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useDependency,
  useDependencyDocs,
  useDependencyUpgrade,
  useMe,
  useTaskGroupMutations,
  useWriteTasks,
} from '../../api/queries.ts'
import { can } from '../../lib/access.ts'
import {
  type LibraryTab,
  behindLabel,
  behindTone,
  libraryTabs,
  narrowImpact,
  rolloutTargets,
  upgradeVersions,
} from '../../lib/dependencies.ts'
import { formatDate, formatRelative, plural } from '../../lib/format.ts'
import { foldOtherTeams } from '../../lib/home-scope.ts'
import {
  excerpt,
  formatRoles,
  groupDocuments,
  headingPath,
  httpUrl,
  librarySearchQuery,
} from '../../lib/libraries.ts'
import { repoKey } from '../../lib/repo.ts'
import { taskGroupCap } from '../../lib/tasks.ts'
import { upgradePrompt } from '../../lib/upgrade-prompt.ts'
import { impactTone, memberLabel } from '../../lib/usages.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import {
  Button,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Markdown,
  Notice,
  OtherTeams,
  Placeholder,
  SearchInput,
  SegmentBar,
  SegmentedTabs,
  Select,
  SeverityChip,
  Tag,
  notify,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'

type Library = { ecosystem: DependencyRow['ecosystem']; name: string }
type User = DependencyDetail['usedBy'][number]

const verdictTone = (verdict: string) =>
  verdict === 'allowed' || verdict === 'internal' || verdict === 'ignored'
    ? 'success'
    : verdict === 'denied'
      ? 'danger'
      : 'warning'

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
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

/** Repositories the scope switch keeps, and how many of other teams are folded away. */
function useFoldedUsers(usedBy: readonly User[]) {
  const { view, scope } = useScope()
  const [expanded, setExpanded] = useState(false)
  const scoped = scope(usedBy)
  const folding = view === 'mine' && scoped.others.items > 0
  return {
    shown: folding && !expanded ? scoped.shown : [...usedBy],
    folded: folding ? scoped.others : undefined,
    expanded,
    toggle: () => setExpanded(!expanded),
    accept: (repo: string) =>
      !folding || expanded || scoped.shown.some((user) => repoKey(user.repo) === repo),
  }
}

/** One library in tabs: Overview, Upgrade and Docs. Used by the side sheet and the full page. */
export function LibraryDetail({
  library,
  tab,
  onTab,
}: {
  library: Library
  tab: LibraryTab
  onTab: (tab: LibraryTab) => void
}) {
  const detail = useDependency(library)
  return (
    <div className="flex flex-col gap-4">
      <SegmentedTabs
        aria-label="Library views"
        items={libraryTabs}
        selected={tab}
        onSelect={(id) => onTab(libraryTabs.find((t) => t.id === id)?.id ?? 'overview')}
      />
      {detail.isPending ? (
        <Placeholder className="h-72" />
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : tab === 'upgrade' ? (
        <UpgradeTab detail={detail.data} />
      ) : tab === 'docs' ? (
        <DocsTab detail={detail.data} />
      ) : (
        <OverviewTab detail={detail.data} />
      )}
    </div>
  )
}

function Facts({ detail }: { detail: DependencyDetail }) {
  const homepage = httpUrl(detail.homepage)
  const repository = httpUrl(detail.repository)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Tag mono>{detail.ecosystem}</Tag>
        {detail.internal ? <Tag tone="accent">internal</Tag> : null}
        <span className="text-muted">
          latest <span className="mono text-foreground">{detail.latest ?? '—'}</span>
          {detail.latestCheckedAt ? ` · checked ${formatRelative(detail.latestCheckedAt)}` : ''}
        </span>
        {homepage ? (
          <a
            href={homepage}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-foreground"
          >
            <ExternalLink className="mr-1 inline size-3" />
            homepage
          </a>
        ) : null}
        {repository ? (
          <a
            href={repository}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-foreground"
          >
            <ExternalLink className="mr-1 inline size-3" />
            repository
          </a>
        ) : null}
        {detail.internal && detail.ecosystem === 'npm' ? (
          <Link
            to="/public-api"
            search={{ package: detail.name }}
            className="text-muted hover:text-foreground"
          >
            Public API
          </Link>
        ) : null}
      </div>
      {detail.description ? <p className="text-sm text-muted">{detail.description}</p> : null}
    </div>
  )
}

function DecisionList({ decisions }: { decisions: readonly DependencyDecision[] }) {
  if (!decisions.length) return null
  return (
    <ul className="flex flex-col gap-1.5">
      {decisions.map((decision) => (
        <li key={decision.id} className="flex flex-wrap items-center gap-2 text-sm">
          <Tag tone={decision.source === 'human' ? 'accent' : 'info'}>{decision.kind}</Tag>
          <Link
            to="/knowledge"
            search={{ tab: 'notes' }}
            className="min-w-0 flex-1 truncate hover:underline"
          >
            {decision.title}
          </Link>
          {decision.shared && decision.owner.length ? (
            <Tag mono>{decision.owner.join(', ')}</Tag>
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

function OverviewTab({ detail }: { detail: DependencyDetail }) {
  const users = useFoldedUsers(detail.usedBy)
  const { homeGroups } = useScope()
  const decisions = foldOtherTeams(detail.decisions, homeGroups, (decision) =>
    decision.shared ? decision.owner : [],
  )
  const sorted = users.shown.toSorted((a, b) => b.majorsBehind - a.majorsBehind)
  return (
    <div className="flex flex-col gap-5">
      <Facts detail={detail} />

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
                to="/repos/view"
                search={{ repo: repoKey(user.repo) }}
                className="min-w-0 flex-1 truncate hover:underline"
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
                {license.verdicts.map((verdict) => (
                  <Tag
                    key={verdict.verdict}
                    tone={verdictTone(verdict.verdict)}
                    title={verdict.repos.join(', ')}
                  >
                    {verdict.verdict} · {verdict.repos.length}
                  </Tag>
                ))}
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
                  {bundle.repo} <span className="text-muted">{bundle.target}</span>
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
              <Tag tone={mr.status === 'broken' ? 'danger' : 'default'}>{mr.status}</Tag>
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
              <span className="text-xs text-muted">{mr.repo}</span>
              {mr.next ? <span className="mono text-xs">→ {mr.next}</span> : null}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/**
 * Starts the upgrade as an agent task group: one task per repository below `to`, the upgrade
 * plan as the prompt. A dialog lists the targets and the spend cap first and says when write
 * tasks are off or the group is too big; the server checks `tasks:run` on each target.
 */
function RollOut({
  name,
  ecosystem,
  from,
  to,
  repos,
  prompt,
}: {
  name: string
  ecosystem: string
  from?: string
  to: string
  repos: string[]
  prompt: () => string
}) {
  const tasks = useTaskGroupMutations()
  const [open, setOpen] = useState(false)
  const write = useWriteTasks(open)
  const cap = write.data ? taskGroupCap(write.data, repos.length) : undefined
  const tooMany = write.data !== undefined && repos.length > write.data.maxRepos
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        isDisabled={repos.length === 0}
        onPress={() => setOpen(true)}
      >
        Roll out
      </Button>
      <ConfirmDialog
        isOpen={open}
        onOpenChange={setOpen}
        title={`Upgrade ${name} to ${to}?`}
        confirmLabel={`Start in ${plural(repos.length, 'repo')}`}
        isPending={tasks.create.isPending}
        isDisabled={write.data?.enabled === false || tooMany}
        onConfirm={() =>
          tasks.create.mutate(
            {
              kind: 'upgrade',
              title: `Upgrade ${name} to ${to}`,
              prompt: prompt(),
              repos,
              run: true,
              source: {
                type: 'dependency-upgrade',
                ecosystem,
                package: name,
                ...(from ? { from } : {}),
                to,
              },
            },
            {
              onSuccess: (group) => {
                setOpen(false)
                notify.success(
                  `Queued ${plural(group.tasks.length, 'task')} on branch ${group.tasks[0]?.branch ?? ''}`,
                )
              },
              onError: (error) => {
                setOpen(false)
                notify.error('Not started', messageOf(error))
              },
            },
          )
        }
      >
        <p>
          An agent bumps {name} and adapts the code in each repository, then opens a draft merge
          request on the same branch. Nothing is merged.
        </p>
        {cap ? (
          <p className="mt-2 text-sm">
            Spend cap <span className="mono">${cap.total.toFixed(2)}</span>
            <span className="text-muted">
              {' '}
              (<span className="mono">${cap.perRepo.toFixed(2)}</span> per repository)
            </span>
          </p>
        ) : null}
        {write.data && !write.data.enabled ? (
          <p className="mt-2 text-sm text-warn">
            Write tasks are turned off; an admin turns them on in Settings → System.
          </p>
        ) : null}
        {tooMany ? (
          <p className="mt-2 text-sm text-warn">
            One task changes at most {write.data?.maxRepos} repositories.
          </p>
        ) : null}
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {repos.map((repo) => (
            <li key={repo}>
              <Tag mono>{repo}</Tag>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  )
}

function UpgradeTab({ detail }: { detail: DependencyDetail }) {
  const options = upgradeVersions(detail)
  const [from, setFrom] = useState<string | undefined>(options.from[0])
  const [to, setTo] = useState<string | undefined>(detail.latest ?? options.to[0])
  const users = useFoldedUsers(detail.usedBy)
  const upgrade = useDependencyUpgrade(
    {
      ecosystem: detail.ecosystem,
      name: detail.name,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
    from !== undefined || to !== undefined,
  )
  const data = upgrade.data
  const impact = data?.impact ? narrowImpact(data.impact, users.accept) : undefined
  const repos = users.shown
    .filter((user) => !to || !user.versions.includes(to))
    .map((user) => ({ repo: repoKey(user.repo), versions: user.versions }))
  const me = useMe()
  const prompt = () =>
    upgradePrompt({
      name: detail.name,
      ecosystem: detail.ecosystem,
      ...(data?.from ? { from: data.from } : {}),
      ...(data?.to ? { to: data.to } : {}),
      repos,
      ...(impact ? { impact } : {}),
      ...(data?.api ? { api: data.api } : {}),
      ...(data?.changes ? { changes: data.changes } : {}),
      notes: data?.notes ?? [],
    })

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label="From"
          className="w-40"
          value={from}
          onChange={setFrom}
          options={options.from.map((version) => ({ id: version, label: version }))}
        />
        <Select
          label="To"
          className="w-40"
          value={to}
          onChange={setTo}
          options={options.to.map((version) => ({
            id: version,
            label: version === detail.latest ? `${version} (latest)` : version,
            text: version,
          }))}
        />
        <div className="ml-auto flex gap-2">
          <CopyButton isDisabled={!data} text={prompt}>
            Copy as prompt
          </CopyButton>
          {data?.to && can(me.data?.principal, 'tasks:run') ? (
            <RollOut
              name={detail.name}
              ecosystem={detail.ecosystem}
              {...(data.from ? { from: data.from } : {})}
              to={data.to}
              repos={rolloutTargets(repos, data.to)}
              prompt={prompt}
            />
          ) : null}
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

      {upgrade.isPending && (from || to) ? (
        <Placeholder className="h-48" />
      ) : upgrade.isError ? (
        <ErrorState error={upgrade.error} />
      ) : data ? (
        <UpgradeBody data={data} impact={impact} />
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
                    <Tag tone={impactTone[item.level]}>{item.level}</Tag>
                    <span className="text-muted">{item.change.change}</span>
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
                <Tag tone={change.change === 'removed' ? 'danger' : 'warning'}>{change.change}</Tag>
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
