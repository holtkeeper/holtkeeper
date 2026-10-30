import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, FileSearch } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'

import { useAuditRuns, useRepos } from '../../api/queries.ts'
import { sparkline } from '../../lib/dashboard.ts'
import { durationBetween, formatDateTime, formatRelative } from '../../lib/format.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import {
  Chip,
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  Select,
  SeverityBar,
} from '../../ui/index.ts'
import { Sparkline } from '../../ui/Sparkline.tsx'
import { triggerLabel } from './labels.ts'

const allRepos = '*'

/** Audit runs, newest first, for one repository or all of them. */
export function AuditsPage() {
  const search = useSearch({ from: '/app/audits' })
  const navigate = useNavigate({ from: '/audits' })
  const repo = parseRepoKey(search.repo)
  const repos = useRepos()
  const runs = useAuditRuns(repo, 100)

  const options = [
    { id: allRepos, label: 'All repositories' },
    ...(repos.data?.repos ?? []).map((r) => ({ id: repoKey(r.repo), label: repoKey(r.repo) })),
  ]
  const list = runs.data?.runs ?? []
  const trend = sparkline(list).map((p) => ({ at: p.at, value: p.active }))

  return (
    <Page
      title="Audits"
      icon="audit"
      description={repo ? `Runs of ${repoKey(repo)}` : 'Runs across every repository you can see'}
      actions={
        <Select
          aria-label="Repository"
          className="w-72"
          options={options}
          value={search.repo ?? allRepos}
          onChange={(id) => void navigate({ search: id === allRepos ? {} : { repo: id } })}
        />
      }
    >
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
        {runs.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Placeholder key={i} className="h-14" />
            ))}
          </div>
        ) : runs.isError ? (
          <ErrorState error={runs.error} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<FileSearch />}
            title="No audit runs yet"
            description="Runs appear here once the CLI or the schedule reports them."
          />
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
