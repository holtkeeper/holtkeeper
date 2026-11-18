import type { FindingGroup } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Bot, ExternalLink, ShieldOff } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useAuditFixes, useTaskGroupMutations, useWriteTasks } from '../../api/queries.ts'
import { formatDate, formatRelative, plural, shortId } from '../../lib/format.ts'
import { parseRepoKey, repoSplat } from '../../lib/repo.ts'
import {
  findingStatusLabel,
  findingStatusTone,
  fixPrompt,
  fixSource,
  fixTargets,
  installedVersions,
  repoStatusCounts,
  urgencyCategoryLabel,
} from '../../lib/security.ts'
import { severityLabel, severityTone } from '../../lib/severity.ts'
import { taskGroupCap } from '../../lib/tasks.ts'
import { httpUrl } from '../../lib/url.ts'
import {
  ConfirmDialog,
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
  { id: 'fixes', label: 'Fix attempts' },
] as const

/**
 * The urgency verdict of a group: urgent or not, what it lets an attacker do, why, who judged it
 * and the Slack alert once posted. Nothing renders while nothing judged the advisory.
 */
function UrgencyNote({ group }: { group: FindingGroup }) {
  const urgency = group.urgency
  if (!urgency) return null
  const slack = urgency.slackUrl ? httpUrl(urgency.slackUrl) : undefined
  return (
    <section
      aria-label="Urgency"
      className={
        urgency.urgent
          ? 'rounded-md border border-danger bg-danger-soft p-3 text-sm'
          : 'rounded-md border border-border p-3 text-sm'
      }
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Tag tone={urgency.urgent ? 'danger' : 'default'} dot>
          {urgency.urgent ? 'Urgent' : 'Not urgent'}
        </Tag>
        <span className="text-xs text-muted">
          {urgencyCategoryLabel[urgency.category]} ·{' '}
          {urgency.by === 'rule' ? 'by rule' : 'judged by AI'} {formatRelative(urgency.at)}
        </span>
        {slack ? (
          <a
            href={slack}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs hover:underline"
          >
            Slack alert <ExternalLink aria-hidden className="size-3" />
          </a>
        ) : null}
      </div>
      <p className="whitespace-pre-line">{urgency.reason}</p>
    </section>
  )
}

function FixAttempts({ group }: { group: FindingGroup }) {
  const fixes = useAuditFixes(
    [group.advisory, ...group.aliases],
    group.repos.map((entry) => entry.repo),
  )
  if (fixes.isPending) return <Placeholder className="h-40" />
  if (fixes.isError) return <ErrorState error={fixes.error} />
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
      <FixTimeline fixes={fixes.data.repos.flatMap((repo) => repo.fixes)} />
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
          {group.urgency?.urgent ? (
            <Tag tone="danger">{group.urgency.category === 'malware' ? 'Malware' : 'Urgent'}</Tag>
          ) : null}
          <Tag tone={severityTone(group.severity)} dot>
            {severityLabel[group.severity]}
          </Tag>
          <span className="mono">{group.package}</span>
          <span>{group.ecosystem}</span>
          <span className="mono">
            {installedVersions(group)[0] ?? '—'} → {group.fixedIn[0] ?? 'no fix'}
          </span>
        </div>
        <UrgencyNote group={group} />
        {fix.reason ? <p className="text-xs text-muted">{fix.reason}</p> : null}
        {current === 'repos' ? (
          <Repositories group={group} />
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
