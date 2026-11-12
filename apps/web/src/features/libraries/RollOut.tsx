import type { DependencyDetail } from '@holtkeeper/api'

import { messageOf } from '../../api/client.ts'
import { useTaskGroupMutations, useWriteTasks } from '../../api/queries.ts'
import { rolloutTargets } from '../../lib/dependencies.ts'
import { plural } from '../../lib/format.ts'
import { taskGroupCap } from '../../lib/tasks.ts'
import { ConfirmDialog, Tag, notify } from '../../ui/index.ts'
import { type UpgradeEnds, useUpgradePlan } from './upgrade-plan.ts'

/**
 * Starts the upgrade as an agent task group: one task per repository in scope below the target,
 * the upgrade plan as the prompt. The dialog lists the targets and the spend cap first and says
 * when write tasks are off or the group is too big; the server checks `tasks:run` on each target.
 * The plan loads only while the dialog is open.
 */
export function RollOutDialog({
  detail,
  ends,
  open,
  onOpenChange,
}: {
  detail: DependencyDetail
  ends: UpgradeEnds
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const tasks = useTaskGroupMutations()
  const write = useWriteTasks(open)
  const plan = useUpgradePlan(detail, ends, open)
  const to = plan.data?.to ?? plan.to
  const repos = to ? rolloutTargets(plan.repos, to) : []
  const cap = write.data ? taskGroupCap(write.data, repos.length) : undefined
  const tooMany = write.data !== undefined && repos.length > write.data.maxRepos
  return (
    <ConfirmDialog
      isOpen={open}
      onOpenChange={onOpenChange}
      title={`Upgrade ${detail.name} to ${to ?? 'the latest version'}?`}
      confirmLabel={`Start in ${plural(repos.length, 'repo')}`}
      isPending={tasks.create.isPending}
      isDisabled={
        !to || !plan.data || repos.length === 0 || write.data?.enabled === false || tooMany
      }
      onConfirm={() => {
        if (!to) return
        tasks.create.mutate(
          {
            kind: 'upgrade',
            title: `Upgrade ${detail.name} to ${to}`,
            prompt: plan.prompt(),
            repos,
            run: true,
            source: {
              type: 'dependency-upgrade',
              ecosystem: detail.ecosystem,
              package: detail.name,
              ...(plan.data?.from ? { from: plan.data.from } : {}),
              to,
            },
          },
          {
            onSuccess: (group) => {
              onOpenChange(false)
              notify.success(
                `Queued ${plural(group.tasks.length, 'task')} on branch ${group.tasks[0]?.branch ?? ''}`,
              )
            },
            onError: (error) => {
              onOpenChange(false)
              notify.error('Not started', messageOf(error))
            },
          },
        )
      }}
    >
      <p>
        An agent bumps {detail.name} and adapts the code in each repository, then opens a draft
        merge request on the same branch. Nothing is merged.
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
          Write tasks are turned off; an admin turns them on in Ops › Tasks.
        </p>
      ) : null}
      {tooMany ? (
        <p className="mt-2 text-sm text-warn">
          One task changes at most {write.data?.maxRepos} repositories.
        </p>
      ) : null}
      {plan.users.folded && !plan.users.expanded ? (
        <p className="mt-2 text-sm text-muted">
          Repositories of {plural(plan.users.folded.teams, 'other team')} are left out.
        </p>
      ) : null}
      {plan.upgrade.isError ? (
        <p className="mt-2 text-sm text-warn">The upgrade plan did not load.</p>
      ) : null}
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {repos.map((repo) => (
          <li key={repo}>
            <Tag mono>{repo}</Tag>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  )
}
