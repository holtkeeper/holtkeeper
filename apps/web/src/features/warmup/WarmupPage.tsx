import type { AnalysisSummary, JobSummary, RepoRef } from '@holtkeeper/api'
import { Link, useSearch } from '@tanstack/react-router'
import { FileText, Flame, ScrollText } from 'lucide-react'

import { useAnalyses, useJobs } from '../../api/queries.ts'
import { analysisPages } from '../../lib/analyses.ts'
import { formatDateTime, formatDuration, formatRef, formatRelative } from '../../lib/format.ts'
import { jobDuration, jobStatusLabel, jobStatusTone, jobTriggerLabel } from '../../lib/jobs.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { type WarmupBuild, warmupRuns } from '../../lib/warmup.ts'
import {
  Chip,
  EmptyState,
  ErrorState,
  LinkButton,
  Page,
  Panel,
  Placeholder,
  Table,
  Td,
  Th,
  Tooltip,
} from '../../ui/index.ts'
import { AnalysisRecords, RepoSelect } from '../analyses/AnalysesPage.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'

const page = analysisPages.find((p) => p.kind === 'warmup') ?? analysisPages[0]

/**
 * Build warm-up: every run of the `warmup` analyzer, newest first, with the command's outcome
 * from its record (a failing build still ends the job as succeeded), its branch, duration and
 * links to the job log and the report with the output; below, duration trends per repository.
 */
export function WarmupPage() {
  const search = useSearch({ strict: false })
  const repo = parseRepoKey(typeof search.repo === 'string' ? search.repo : undefined)
  return (
    <Page
      title={page.title}
      icon={page.icon}
      description={repo ? `${page.description} · ${repoKey(repo)}` : page.description}
      actions={
        <div className="flex items-center gap-2">
          <RepoSelect to={page.to} />
          <RunJobButton
            analyzer="warmup"
            label="Run now"
            variant="secondary"
            {...(repo ? { repo } : {})}
          />
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        <RunsPanel {...(repo ? { repo } : {})} />
        <AnalysisRecords page={page} {...(repo ? { repo } : {})} />
      </div>
    </Page>
  )
}

function RunsPanel({ repo }: { repo?: RepoRef }) {
  const jobs = useJobs({ analyzer: 'warmup', limit: 100, ...(repo ? { repo } : {}) })
  const analyses = useAnalyses('warmup', repo, 500)
  const runs = warmupRuns(jobs.data?.jobs ?? [], analyses.data?.analyses ?? [])
  const now = new Date()
  return (
    <Panel
      title="Runs"
      description="Newest first; queued and running ones included."
      contentClassName="p-0"
    >
      {jobs.isPending ? (
        <div className="flex flex-col gap-2 p-4">
          {[0, 1, 2].map((i) => (
            <Placeholder key={i} className="h-10" />
          ))}
        </div>
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} />
      ) : runs.length === 0 ? (
        <EmptyState
          icon={<Flame />}
          title="Nothing warmed up yet"
          description="Set the command in the analyzers.warmup setting and add a Branch push trigger with the warmup analyzer in Automation."
        />
      ) : (
        <Table label="Warm-up runs">
          <thead>
            <tr>
              <Th>Build</Th>
              {repo ? null : <Th>Repository</Th>}
              <Th>Branch</Th>
              <Th>Commit</Th>
              <Th>Trigger</Th>
              <Th>Started</Th>
              <Th align="right">Duration</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <RunRow key={run.job.id} run={run} showRepo={!repo} now={now} />
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  )
}

function RunRow({
  run,
  showRepo,
  now,
}: {
  run: { job: JobSummary; analysis?: AnalysisSummary; build: WarmupBuild }
  showRepo: boolean
  now: Date
}) {
  const { job, analysis, build } = run
  const at = job.startedAt ?? job.createdAt
  const duration = build.durationMs ?? jobDuration(job, now)
  return (
    <tr>
      <Td>
        {build.status ? (
          <Chip tone={build.status === 'ok' ? 'success' : 'danger'}>{build.status}</Chip>
        ) : (
          <Chip tone={jobStatusTone(job.status)}>{jobStatusLabel(job.status)}</Chip>
        )}
      </Td>
      {showRepo ? (
        <Td>
          <Link
            to="/warmup"
            search={{ repo: repoKey(job.repo) }}
            className="font-mono text-xs hover:underline"
          >
            {job.repo.path}
          </Link>
        </Td>
      ) : null}
      <Td className="font-mono text-xs">{build.branch ?? <span className="text-muted">—</span>}</Td>
      <Td>
        {job.ref ? (
          <span className="font-mono text-xs" title={job.ref}>
            {formatRef(job.ref)}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
      <Td className="text-muted">{jobTriggerLabel(job.trigger)}</Td>
      <Td className="whitespace-nowrap">
        <Tooltip content={formatDateTime(at)}>
          <time tabIndex={0} dateTime={at}>
            {formatRelative(at, now)}
          </time>
        </Tooltip>
      </Td>
      <Td align="right" className="whitespace-nowrap tabular-nums">
        {duration === undefined ? <span className="text-muted">—</span> : formatDuration(duration)}
      </Td>
      <Td align="right" className="whitespace-nowrap">
        <div className="flex justify-end gap-1">
          <LinkButton
            to="/jobs/$jobId"
            params={{ jobId: job.id }}
            variant="ghost"
            size="sm"
            aria-label="Job log"
          >
            <ScrollText className="size-4" />
          </LinkButton>
          {analysis ? (
            <LinkButton
              to="/analyses/$id"
              params={{ id: analysis.id }}
              search={{}}
              variant="ghost"
              size="sm"
              aria-label="Report with output"
            >
              <FileText className="size-4" />
            </LinkButton>
          ) : null}
        </div>
      </Td>
    </tr>
  )
}
