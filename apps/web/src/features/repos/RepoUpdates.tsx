import type { RepoRef, RepoUpdatesView } from '@holtkeeper/api'
import { Link2, PlugZap, RefreshCw, Trash2, Webhook } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useRepoUpdateMutations, useRepoUpdates } from '../../api/queries.ts'
import { formatDate, formatRelative } from '../../lib/format.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  CopyField,
  ErrorState,
  Notice,
  Panel,
  Placeholder,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { PollAttempts } from './Attempts.tsx'
import { pollEventLabel, pollingCadence } from './updates.ts'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

/** How a repository learns about forge changes: polling status and its own webhook URL. */
export function RepoUpdates({
  repo,
  onOpenSettings,
}: {
  repo: RepoRef
  onOpenSettings: () => void
}) {
  const updates = useRepoUpdates(repo)
  if (updates.isPending) return <Placeholder className="h-64" />
  if (updates.isError) return <ErrorState error={updates.error} />
  return (
    <div className="flex flex-col gap-4">
      <PollingPanel repo={repo} view={updates.data} onOpenSettings={onOpenSettings} />
      <WebhookPanel repo={repo} view={updates.data} />
    </div>
  )
}

function PollingPanel({
  repo,
  view,
  onOpenSettings,
}: {
  repo: RepoRef
  view: RepoUpdatesView
  onOpenSettings: () => void
}) {
  const { can } = useSession()
  const { poll } = useRepoUpdateMutations(repo)
  const { polling } = view
  const cadence = pollingCadence(view)
  const now = new Date()

  return (
    <Panel
      title="Polling"
      description="Holtkeeper looks for merge request changes, comments, finished pipelines and tags on its own and reacts as it would to a webhook."
      actions={
        <>
          <Button variant="ghost" size="sm" onPress={onOpenSettings}>
            Configure
          </Button>
          {can('settings:write') ? (
            <Button
              variant="secondary"
              size="sm"
              isPending={poll.isPending}
              onPress={() =>
                poll.mutate(undefined, {
                  onSuccess: (result) =>
                    result.error
                      ? notify.error('Poll failed', result.error)
                      : result.skipped
                        ? notify.info('Not polled', result.skipped)
                        : notify.success(
                            `${result.events ?? 0} change(s) found`,
                            `${result.enqueued ?? 0} job(s) queued`,
                          ),
                  onError: (error) => notify.error('Poll failed', messageOf(error)),
                })
              }
            >
              <RefreshCw className="size-3.5" />
              Poll now
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Fact label="Cadence">
            <Chip tone={cadence.tone === 'default' ? 'default' : cadence.tone} size="sm">
              {cadence.text}
            </Chip>
          </Fact>
          <Fact label="Looks for">
            {polling.enabled ? polling.events.map(pollEventLabel).join(', ') : '—'}
          </Fact>
          <Fact label="Last poll">
            {polling.lastPolledAt ? (
              <span title={formatDate(polling.lastPolledAt)}>
                {formatRelative(polling.lastPolledAt, now)}
                {polling.lastEvents !== undefined ? (
                  <span className="text-muted">
                    {' '}
                    · {polling.lastEvents} change(s), {polling.lastRequests ?? 0} request(s)
                  </span>
                ) : null}
              </span>
            ) : (
              'Never'
            )}
          </Fact>
          <Fact label="Next poll">
            {polling.nextAt ? (
              <span title={formatDate(polling.nextAt)}>{formatRelative(polling.nextAt, now)}</span>
            ) : (
              '—'
            )}
          </Fact>
        </dl>
        {cadence.detail ? (
          <p className={cadence.tone === 'warning' ? 'text-sm text-warning' : 'text-sm text-muted'}>
            {cadence.detail}
          </p>
        ) : null}
        {!polling.enabled ? (
          <p className="text-sm text-muted">
            Turn it on with the <strong>Polling</strong> setting (section Updates) for this
            repository, its group or everything. Requests are drawn from token{' '}
            <code className="font-mono text-xs">{polling.key}</code> and share its budget with every
            repository on it.
          </p>
        ) : null}
        {polling.lastError ? (
          <Notice tone="danger" title="Last poll failed">
            {polling.lastError}
          </Notice>
        ) : null}
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">Recent polls</h4>
          <PollAttempts attempts={polling.attempts} />
        </div>
      </div>
    </Panel>
  )
}

function WebhookPanel({ repo, view }: { repo: RepoRef; view: RepoUpdatesView }) {
  const { can } = useSession()
  const writable = can('settings:write')
  const { issueWebhook, removeWebhook } = useRepoUpdateMutations(repo)
  const [confirm, setConfirm] = useState<'rotate' | 'remove' | null>(null)
  const hook = view.webhook
  const registered = hook?.registered ?? []
  const now = new Date()

  const issue = (register?: boolean) =>
    issueWebhook.mutate(register, {
      onSuccess: () => {
        setConfirm(null)
        notify.success(
          hook ? 'New webhook URL issued' : 'Webhook URL issued',
          hook ? 'The previous URL no longer works.' : undefined,
        )
      },
      onError: (error) => notify.error('Webhook not updated', messageOf(error)),
    })

  return (
    <Panel
      title="Webhook"
      description="With a webhook the forge reports changes the moment they happen, and polling slows down to a safety net."
      actions={
        writable && hook ? (
          <>
            {view.canRegister && registered.length === 0 ? (
              <Button
                variant="ghost"
                size="sm"
                isPending={issueWebhook.isPending}
                onPress={() => issue(true)}
              >
                <PlugZap className="size-3.5" />
                Register on GitLab
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onPress={() => setConfirm('rotate')}>
              <RefreshCw className="size-3.5" />
              Regenerate
            </Button>
            <Button variant="ghost" size="sm" onPress={() => setConfirm('remove')}>
              <Trash2 className="size-3.5" />
              Turn off
            </Button>
          </>
        ) : null
      }
    >
      {hook ? (
        <div className="flex flex-col gap-4">
          {hook.url ? (
            <CopyField value={hook.url} label="webhook URL" />
          ) : (
            <p className="text-sm text-muted">
              The URL is shown to people who may change this repository's settings.
            </p>
          )}
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Fact label="Issued">{formatDate(hook.createdAt)}</Fact>
            <Fact label="On the forge">
              {registered.length ? (
                <Chip tone="success" size="sm">
                  Registered
                </Chip>
              ) : (
                <span className="text-muted">Added by hand</span>
              )}
            </Fact>
            <Fact label="Last delivery">
              {hook.lastDelivery ? (
                <span title={formatDate(hook.lastDelivery.at)}>
                  {formatRelative(hook.lastDelivery.at, now)}
                </span>
              ) : (
                'None yet'
              )}
            </Fact>
            <Fact label="Result">
              {hook.lastDelivery ? (
                hook.lastDelivery.ignored ? (
                  <span className="text-muted" title={hook.lastDelivery.ignored}>
                    {hook.lastDelivery.event}: ignored
                  </span>
                ) : (
                  `${hook.lastDelivery.event}: ${hook.lastDelivery.enqueued} job(s)`
                )
              ) : (
                '—'
              )}
            </Fact>
          </dl>
          {registered.length === 0 && hook.url ? (
            <p className="text-sm text-muted">
              In GitLab, open the project's <strong>Settings → Webhooks</strong>, paste the URL and
              tick <strong>Tag push</strong>, <strong>Merge request</strong>,{' '}
              <strong>Comments</strong> and <strong>Pipeline</strong> events. The secret token can
              stay empty: the URL is the secret.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-separator p-3 text-sm text-muted">
          <span className="flex items-center gap-2">
            <Webhook className="size-4" />
            {view.webhookSeenAt
              ? `No URL of its own; a forge-wide webhook last reported ${formatRelative(view.webhookSeenAt, now)}.`
              : 'No webhook URL yet.'}
          </span>
          {writable ? (
            <span className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                isPending={issueWebhook.isPending}
                onPress={() => issue(false)}
              >
                <Link2 className="size-3.5" />
                Generate URL
              </Button>
              {view.canRegister ? (
                <Button
                  variant="primary"
                  size="sm"
                  isPending={issueWebhook.isPending}
                  onPress={() => issue(true)}
                >
                  <PlugZap className="size-3.5" />
                  Generate and register on GitLab
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        isOpen={confirm === 'rotate'}
        onOpenChange={(open) => setConfirm(open ? 'rotate' : null)}
        title="Regenerate the webhook URL?"
        confirmLabel="Regenerate"
        isPending={issueWebhook.isPending}
        onConfirm={() => issue()}
      >
        The current URL stops working at once.{' '}
        {registered.length
          ? 'The hook on the forge is replaced with the new URL.'
          : 'Paste the new URL into the forge afterwards.'}
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm === 'remove'}
        onOpenChange={(open) => setConfirm(open ? 'remove' : null)}
        title="Turn the webhook off?"
        confirmLabel="Turn off"
        isPending={removeWebhook.isPending}
        onConfirm={() =>
          removeWebhook.mutate(undefined, {
            onSuccess: () => {
              setConfirm(null)
              notify.success('Webhook turned off')
            },
            onError: (error) => notify.error('Webhook not removed', messageOf(error)),
          })
        }
      >
        The URL stops working{registered.length ? ' and the hook is removed from the forge' : ''}.
        Polling goes back to its regular interval within a day.
      </ConfirmDialog>
    </Panel>
  )
}
