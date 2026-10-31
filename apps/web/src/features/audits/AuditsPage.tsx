import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, FileSearch } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'

import { useAuditRuns, useRepos } from '../../api/queries.ts'
import { sparkline } from '../../lib/dashboard.ts'
import { durationBetween, formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import {
  Chip,
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  Segmented,
  Select,
  SeverityBar,
} from '../../ui/index.ts'
import { Sparkline } from '../../ui/Sparkline.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { type AuditsSearch, isTrigger, triggerLabel } from './labels.ts'

const allRepos = '*'
const anyTrigger = '*'

/** Audit runs, newest first: by default the latest run of each repository, or every run. */
export function AuditsPage() {
  const search = useSearch({ from: '/app/audits' })
  const navigate = useNavigate({ from: '/audits' })
  const repo = parseRepoKey(search.repo)
  const latestOnly = !repo && search.view !== 'all'
  const repos = useRepos()
  const runs = useAuditRuns(repo, 100, !latestOnly)
  const update = (patch: Partial<AuditsSearch>) =>
    void navigate({
      search: (prev) =>
        Object.fromEntries(
          Object.entries({ ...prev, ...patch }).filter(([, value]) => value !== undefined),
        ),
    })

  const options = [
    { id: allRepos, label: 'All repositories' },
    ...(repos.data?.repos ?? []).map((r) => ({ id: repoKey(r.repo), label: repoKey(r.repo) })),
  ]
  const source = latestOnly
    ? (repos.data?.repos ?? [])
        .flatMap((r) => (r.latestAudit ? [r.latestAudit] : []))
        .toSorted((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    : (runs.data?.runs ?? [])
  const list = source.filter(
    (run) =>
      (!search.trigger || run.trigger === search.trigger) &&
      (!search.findings || (search.findings === 'open') === run.active > 0),
  )
  const query = latestOnly ? repos : runs
  const trend = sparkline(list).map((p) => ({ at: p.at, value: p.active }))
  const filtered = list.length !== source.length

  return (
    <Page
      title="Audits"
      icon="audit"
      description={
        repo
          ? `Runs of ${repoKey(repo)}`
          : latestOnly
            ? 'The latest run of each repository you can see'
            : 'Every run across the repositories you can see'
      }
      actions={<RunJobButton analyzer="audit" label="Run audit" {...(repo ? { repo } : {})} />}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Repository"
          className="w-72"
          options={options}
          value={search.repo ?? allRepos}
          onChange={(id) => update({ repo: id === allRepos ? undefined : id })}
        />
        {repo ? null : (
          <Segmented
            aria-label="Runs"
            value={latestOnly ? 'latest' : 'all'}
            onChange={(id) => update({ view: id === 'all' ? 'all' : undefined })}
            options={[
              { id: 'latest', label: 'Latest per repository' },
              { id: 'all', label: 'All runs' },
            ]}
          />
        )}
        <Select
          aria-label="Trigger"
          className="w-40"
          options={[
            { id: anyTrigger, label: 'Any trigger' },
            ...Object.entries(triggerLabel).map(([id, label]) => ({ id, label })),
          ]}
          value={search.trigger ?? anyTrigger}
          onChange={(id) => update({ trigger: isTrigger(id) ? id : undefined })}
        />
        <Segmented
          aria-label="Findings"
          value={search.findings ?? 'any'}
          onChange={(id) => update({ findings: id === 'any' ? undefined : id })}
          options={[
            { id: 'any', label: 'Any' },
            { id: 'open', label: 'With findings' },
            { id: 'clean', label: 'Clean' },
          ]}
        />
        {query.isSuccess ? (
          <span className="ml-auto text-xs text-muted" aria-live="polite">
            {filtered
              ? `${list.length} of ${plural(source.length, 'run')}`
              : plural(list.length, 'run')}
          </span>
        ) : null}
      </div>

      {repo && list.length > 1 ? (
        <Panel
          title="Active findings per run"
          description={`${list.length} runs, oldest to newest`}
        >
          <Sparkline
            points={trend}
            label={`Active findings across ${list.length} runs`}
            height={72}
          />
        </Panel>
      ) : null}

      <Panel contentClassName="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Placeholder key={i} className="h-14" />
            ))}
          </div>
        ) : query.isError ? (
          <ErrorState error={query.error} />
        ) : list.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={<FileSearch />}
              title="No runs match"
              description="Change or clear the filters to see more runs."
            />
          ) : (
            <EmptyState
              icon={<FileSearch />}
              title="No audit runs yet"
              description="Runs appear here once the CLI or the schedule reports them."
            />
          )
        ) : (
          <ul className="divide-y divide-separator">
            <AnimatePresence initial={false}>
              {list.map((run, index) => (
                <motion.li
                  key={run.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0, transition: { delay: Math.min(index, 12) * 0.02 } }}
                  exit={{ opacity: 0 }}
                >
                  <Link
                    to="/audits/$runId"
                    params={{ runId: run.id }}
                    className="grid items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-default-soft focus-visible:bg-default-soft focus-visible:outline-none sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto]"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {repo ? formatDateTime(run.finishedAt) : repoKey(run.repo)}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                        <span title={formatDateTime(run.finishedAt)}>
                          {formatRelative(run.finishedAt)}
                        </span>
                        <span>·</span>
                        <span>{durationBetween(run.startedAt, run.finishedAt)}</span>
                        <Chip size="sm">{triggerLabel[run.trigger]}</Chip>
                        {run.tools.slice(0, 3).map((tool) => (
                          <span key={tool} className="rounded bg-default px-1.5 py-0.5">
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>
                    <SeverityBar counts={run.severities} />
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <span>
                        <span className="tabular text-base font-semibold text-foreground">
                          {run.active}
                        </span>{' '}
                        active
                      </span>
                      {run.resolved ? (
                        <span className="text-success">{run.resolved} fixed</span>
                      ) : null}
                      {run.expiredAllowlist ? (
                        <span className="text-warning">{run.expiredAllowlist} expired</span>
                      ) : null}
                    </div>
                    <ChevronRight className="hidden size-4 text-muted sm:block" />
                  </Link>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Panel>
    </Page>
  )
}
