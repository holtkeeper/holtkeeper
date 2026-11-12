import type { FindingGroup } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Bot, ExternalLink, FileSearch, ShieldOff } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useAuditRunDetails,
  useAuditRuns,
  useTaskGroupMutations,
  useWriteTasks,
} from '../../api/queries.ts'
import { formatDate, formatRelative, plural, shortId } from '../../lib/format.ts'
import { parseRepoKey, repoKey, repoSplat } from '../../lib/repo.ts'
import {
  findingStatusLabel,
  findingStatusTone,
  fixPrompt,
  fixSource,
  fixTargets,
  installedVersions,
  repoStatusCounts,
} from '../../lib/security.ts'
import { severityLabel, severityTone } from '../../lib/severity.ts'
import { taskGroupCap } from '../../lib/tasks.ts'
import { httpUrl } from '../../lib/url.ts'
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  KeyValue,
  Placeholder,
  SideSheet,
  Table,
  Tag,
  Td,
  Th,
  notify,
  quietActionsOf,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { AllowlistDialog } from './AllowlistDialog.tsx'
import { FixTimeline } from './FixTimeline.tsx'

const tabs = [
  { id: 'repos', label: 'Repositories' },
  { id: 'details', label: 'Details' },
  { id: 'runs', label: 'Run history' },
  { id: 'fixes', label: 'Fix attempts' },
] as const

const repoSet = (group: FindingGroup) => new Set(group.repos.map((entry) => entry.repo))

function RunHistory({ group }: { group: FindingGroup }) {
  const runs = useAuditRuns()
  if (runs.isPending) return <Placeholder className="h-40" />
  if (runs.isError) return <ErrorState error={runs.error} />
  const repos = repoSet(group)
  const list = runs.data.runs.filter((run) => repos.has(repoKey(run.repo)))
  if (!list.length)
    return <EmptyState icon={<FileSearch />} title="No audit runs of these repositories" />
  return (
    <Table label="Audit runs of the repositories with this finding">
      <thead>
        <tr>
          <Th>Run</Th>
          <Th>Repository</Th>
          <Th align="right">Active</Th>
          <Th>When</Th>
        </tr>
      </thead>
      <tbody>
        {list.map((run) => (
          <tr key={run.id}>
            <Td>
              <Link
                to="/supply/security/runs/$runId"
                params={{ runId: run.id }}
                className="mono text-[12.5px] hover:underline"
              >
                {shortId(run.id)}
              </Link>
            </Td>
            <Td className="mono text-[12.5px]">{run.repo.path}</Td>
            <Td align="right" className="tabular">
              {run.active}
            </Td>
            <Td className="text-xs text-muted">{formatRelative(run.finishedAt)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

function FixAttempts({ group }: { group: FindingGroup }) {
  const runs = useAuditRuns()
  const repos = repoSet(group)
  const newest = new Map<string, string>()
  for (const run of runs.data?.runs ?? []) {
    const key = repoKey(run.repo)
    if (repos.has(key) && !newest.has(key)) newest.set(key, run.id)
  }
  const details = useAuditRunDetails([...newest.values()])
  if (runs.isPending || details.some((detail) => detail.isPending))
    return <Placeholder className="h-40" />
  if (runs.isError) return <ErrorState error={runs.error} />
  const ids = new Set([group.advisory, ...group.aliases])
  const fixes = details.flatMap(
    (detail) =>
      detail.data?.run.report.fixes.filter((fix) =>
        fix.requested.some((requested) => ids.has(requested)),
      ) ?? [],
  )
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        Fixers the newest audit of each repository ran for this advisory.
        {group.taskId ? (
          <>
            {' '}
            An agent task is fixing it:{' '}
            <Link
              to="/ops/tasks"
              search={{ group: group.taskId }}
              className="mono text-foreground hover:underline"
            >
              {shortId(group.taskId)}
            </Link>
            .
          </>
        ) : null}
      </p>
      <FixTimeline fixes={fixes} />
    </div>
  )
}

function Repositories({ group }: { group: FindingGroup }) {
  return (
    <Table label="Repositories with this finding">
      <thead>
        <tr>
          <Th>Repository</Th>
          <Th>In use</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {group.repos.map((entry) => {
          const ref = parseRepoKey(entry.repo)
          return (
            <tr key={entry.repo}>
              <Td>
                <span className="flex flex-col leading-tight">
                  {ref ? (
                    <Link
                      to="/repos/$"
                      params={{ _splat: repoSplat(ref) }}
                      search={{ tab: 'supply', section: 'security' }}
                      className="mono text-[12.5px] hover:underline"
                    >
                      {ref.path}
                    </Link>
                  ) : (
                    <span className="mono text-[12.5px]">{entry.repo}</span>
                  )}
                  {entry.sources.length ? (
                    <span className="mono text-[11px] text-dim">{entry.sources.join(', ')}</span>
                  ) : null}
                </span>
              </Td>
              <Td className="mono text-[12.5px]">{entry.versions.join(', ') || '—'}</Td>
              <Td>
                <span className="flex flex-col items-start gap-0.5">
                  <Tag tone={findingStatusTone(entry.status)} dot>
                    {findingStatusLabel[entry.status]}
                  </Tag>
                  {entry.taskId ? (
                    <Link to="/ops/tasks" className="mono text-[11px] text-dim hover:underline">
                      task {entry.taskId.slice(0, 8)}
                    </Link>
                  ) : null}
                </span>
              </Td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}

function Details({ group }: { group: FindingGroup }) {
  const url = httpUrl(group.url)
  return (
    <KeyValue
      rows={[
        {
          label: 'Advisory',
          value: url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="mono inline-flex items-center gap-1 hover:underline"
            >
              {group.advisory}
              <ExternalLink className="size-3" />
            </a>
          ) : (
            <span className="mono">{group.advisory}</span>
          ),
        },
        {
          label: 'Aliases',
          value: group.aliases.length ? (
            <span className="mono">{group.aliases.join(', ')}</span>
          ) : null,
        },
        { label: 'Ecosystem', value: group.ecosystem },
        {
          label: 'Installed',
          value: <span className="mono">{installedVersions(group).join(', ') || '—'}</span>,
        },
        {
          label: 'Fixed in',
          value: group.fixedIn.length ? (
            <span className="mono">{group.fixedIn.join(', ')}</span>
          ) : (
            <span className="text-muted">No fixed version yet</span>
          ),
        },
        {
          label: 'First seen',
          value: `${formatDate(group.firstSeenAt)} · ${formatRelative(group.firstSeenAt)}`,
        },
        { label: 'Summary', value: group.summary },
      ]}
    />
  )
}

function useFixWithAgent(group: FindingGroup) {
  const { can } = useSession()
  const tasks = useTaskGroupMutations()
  const write = useWriteTasks()
  const [open, setOpen] = useState(false)
  const targets = fixTargets(group)
  const source = fixSource(group)
  const run = can('tasks:run')
  const cap = write.data ? taskGroupCap(write.data, targets.length) : undefined
  const tooMany = write.data !== undefined && targets.length > write.data.maxRepos
  const reason = write.isError
    ? 'Could not check whether write tasks are on.'
    : write.data && !write.data.enabled
      ? 'Write tasks are turned off; an admin turns them on in Ops › Tasks.'
      : targets.length === 0
        ? 'No repository has this finding open.'
        : !source
          ? 'No fixed version is published yet, so there is nothing to upgrade to.'
          : tooMany
            ? `One task changes at most ${write.data?.maxRepos} repositories.`
            : undefined
  const dialog = (
    <ConfirmDialog
      isOpen={open}
      onOpenChange={setOpen}
      title={`Fix ${group.advisory} in ${group.package}?`}
      confirmLabel={
        run
          ? `Start in ${plural(targets.length, 'repo')}`
          : `Propose for ${plural(targets.length, 'repo')}`
      }
      isPending={tasks.create.isPending}
      isDisabled={!write.data || reason !== undefined}
      onConfirm={() => {
        if (!source) return
        tasks.create.mutate(
          {
            kind: 'fix',
            title: `Fix ${group.advisory} in ${group.package}`,
            prompt: fixPrompt(group),
            repos: targets,
            run,
            source,
          },
          {
            onSuccess: (created) => {
              setOpen(false)
              notify.success(
                run
                  ? `Queued ${plural(created.tasks.length, 'task')}`
                  : 'Proposed; it starts once someone approves it in Inbox',
              )
            },
            onError: (error) => {
              setOpen(false)
              notify.error('Not started', messageOf(error))
            },
          },
        )
      }}
    >
      {reason ? <p className="mb-2 text-sm text-warn">{reason}</p> : null}
      <p>
        An agent upgrades {group.package} to {source?.to} in each repository where the finding is
        open and opens a draft merge request. Nothing is merged.
      </p>
      {run ? null : (
        <p className="mt-2 text-sm text-muted">
          You cannot approve agent tasks, so this is proposed and waits for approval in Inbox.
        </p>
      )}
      {cap ? (
        <p className="mt-2 text-sm">
          Spend cap <span className="mono">${cap.total.toFixed(2)}</span>
          <span className="text-muted">
            {' '}
            (<span className="mono">${cap.perRepo.toFixed(2)}</span> per repository)
          </span>
        </p>
      ) : null}
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {targets.map((repo) => (
          <li key={repo}>
            <Tag mono>{repo}</Tag>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  )
  return { open: () => setOpen(true), reason, dialog }
}

/**
 * One finding group in the side sheet: severity, versions and status per repository, the audit
 * runs of those repositories and the fix attempts their newest audits made for the advisory, with
 * the quiet actions "Fix with agent" (its dialog cannot confirm while write tasks are off and says
 * why) and, with `settings:write`, "Allowlist…". Nothing renders without a group.
 */
export function FindingSheet({
  group,
  tab,
  onTab,
  onClose,
  index,
  total,
  onPrevious,
  onNext,
}: {
  group: FindingGroup | undefined
  tab: string | undefined
  onTab: (tab: string) => void
  onClose: () => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const { can } = useSession()
  const [allowlisting, setAllowlisting] = useState(false)
  if (!group) return null
  return (
    <GroupSheet
      group={group}
      tab={tab}
      onTab={onTab}
      onClose={onClose}
      canAllowlist={can('settings:write')}
      allowlisting={allowlisting}
      onAllowlist={setAllowlisting}
      {...(index !== undefined && total !== undefined ? { index, total } : {})}
      {...(onPrevious ? { onPrevious } : {})}
      {...(onNext ? { onNext } : {})}
    />
  )
}

function GroupSheet({
  group,
  tab,
  onTab,
  onClose,
  canAllowlist,
  allowlisting,
  onAllowlist: setAllowlisting,
  index,
  total,
  onPrevious,
  onNext,
}: {
  group: FindingGroup
  tab: string | undefined
  onTab: (tab: string) => void
  onClose: () => void
  canAllowlist: boolean
  allowlisting: boolean
  onAllowlist: (open: boolean) => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const fix = useFixWithAgent(group)
  const quiet = quietActionsOf([
    { label: 'Fix with agent', icon: Bot, onPress: fix.open },
    ...(canAllowlist
      ? [{ label: 'Allowlist…', icon: ShieldOff, onPress: () => setAllowlisting(true) }]
      : []),
  ])
  const counts = repoStatusCounts(group)
  const current = tabs.find((entry) => entry.id === tab)?.id ?? 'repos'
  return (
    <SideSheet
      open
      onClose={onClose}
      id={group.advisory}
      copyId={group.advisory}
      title={group.summary ?? `${group.advisory} in ${group.package}`}
      {...(index !== undefined && total !== undefined ? { index, total } : {})}
      {...(onPrevious ? { onPrevious } : {})}
      {...(onNext ? { onNext } : {})}
      {...(quiet && { quietActions: quiet })}
      progress={{
        segments: [
          { value: counts.open, tone: 'danger', label: 'open' },
          { value: counts.fixing, tone: 'info', label: 'fixing' },
          { value: counts.allowlisted, tone: 'default', label: 'allowlisted' },
        ],
        label: `${counts.open} open · ${counts.fixing} fixing · ${counts.allowlisted} allowlisted`,
      }}
      tabs={{
        items: tabs.map((entry) => ({
          id: entry.id,
          label: entry.id === 'repos' ? `Repositories ${group.repos.length}` : entry.label,
        })),
        selected: current,
        onSelect: onTab,
        'aria-label': 'Finding sections',
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Tag tone={severityTone(group.severity)} dot>
            {severityLabel[group.severity]}
          </Tag>
          <span className="mono">{group.package}</span>
          <span>{group.ecosystem}</span>
          <span className="mono">
            {installedVersions(group)[0] ?? '—'} → {group.fixedIn[0] ?? 'no fix'}
          </span>
        </div>
        {fix.reason ? <p className="text-xs text-muted">{fix.reason}</p> : null}
        {current === 'repos' ? (
          <Repositories group={group} />
        ) : current === 'runs' ? (
          <RunHistory group={group} />
        ) : current === 'fixes' ? (
          <FixAttempts group={group} />
        ) : (
          <Details group={group} />
        )}
      </div>
      {fix.dialog}
      {allowlisting ? (
        <AllowlistDialog group={group} onClose={() => setAllowlisting(false)} />
      ) : null}
    </SideSheet>
  )
}
