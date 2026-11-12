import type { SlackReviewStatusName, SlackSettingsView } from '@holtkeeper/api'
import { Save, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useSlackMutations, useSlackSettings } from '../../api/queries.ts'
import { formatRelative } from '../../lib/format.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  CopyField,
  ErrorState,
  Panel,
  Placeholder,
  TextField,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { slackEmojiError } from './slack-emoji.ts'

const statusLabels: Readonly<Record<SlackReviewStatusName, string>> = {
  reviewing: 'Reviewing',
  clean: 'Looks good',
  minor: 'Minor findings',
  changes: 'Needs changes',
  skipped: 'Not reviewed',
}

const statuses: readonly SlackReviewStatusName[] = [
  'reviewing',
  'clean',
  'minor',
  'changes',
  'skipped',
]

/** The review status emoji of the stored credential, each blank field falling back to its default. */
function SlackEmojiForm({ view }: { view: SlackSettingsView }) {
  const { setEmoji } = useSlackMutations()
  const [draft, setDraft] = useState<Partial<Record<SlackReviewStatusName, string>>>(view.emoji)
  const invalid = statuses.some((status) => slackEmojiError(draft[status]) !== undefined)
  return (
    <form
      className="flex flex-col gap-3 border-t border-border pt-3"
      onSubmit={(event) => {
        event.preventDefault()
        const emoji = Object.fromEntries(
          statuses.flatMap((status) => {
            const name = draft[status]?.trim()
            return name ? [[status, name]] : []
          }),
        )
        setEmoji.mutate(
          { emoji },
          {
            onSuccess: () => notify.success('Slack emoji saved'),
            onError: (error) => notify.error('Not saved', messageOf(error)),
          },
        )
      }}
    >
      <p className="text-sm font-medium">Review status emoji</p>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {statuses.map((status) => (
          <TextField
            key={status}
            label={statusLabels[status]}
            value={draft[status] ?? ''}
            onChange={(value) => setDraft((current) => ({ ...current, [status]: value }))}
            placeholder={view.defaultEmoji[status]}
            error={slackEmojiError(draft[status])}
            autoComplete="off"
            mono
          />
        ))}
      </div>
      <p className="text-xs text-muted">
        Slack emoji names without colons; blank fields use the default shown.
      </p>
      <div>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          isPending={setEmoji.isPending}
          isDisabled={invalid}
        >
          <Save className="size-4" aria-hidden /> Save emoji
        </Button>
      </div>
    </form>
  )
}

/** The emoji each review status shows, for readers who cannot change them. */
function SlackEmojiList({ view }: { view: SlackSettingsView }) {
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <p className="text-sm font-medium">Review status emoji</p>
      <dl className="grid gap-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
        {statuses.map((status) => (
          <div key={status}>
            <dt className="text-xs text-muted">{statusLabels[status]}</dt>
            <dd className="font-mono text-[13px]">
              {view.emoji[status] ?? view.defaultEmoji[status]}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * The Slack app credential: whether its tokens are set, a form to replace or forget them, and
 * the review status emoji once they are set.
 */
export function SlackTokensSection() {
  const { canGlobal } = useSession()
  const readable = canGlobal('settings:read')
  const writable = canGlobal('settings:write')
  const settings = useSlackSettings(readable)
  const { connect, disconnect } = useSlackMutations()
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [confirming, setConfirming] = useState(false)
  if (!readable) return null
  const view = settings.data

  return (
    <Panel
      title="Slack"
      description="Bot token and signing secret of the Slack app that marks merge request links in bound channels (slack.reviews) with a review status emoji."
      actions={
        view?.configured ? (
          <Chip tone="success">
            set
            {view.connectedAt ? ` ${formatRelative(view.connectedAt)}` : ''}
            {view.connectedBy ? ` by ${view.connectedBy}` : ''}
          </Chip>
        ) : view ? (
          <Chip>not set</Chip>
        ) : null
      }
    >
      {view ? (
        <div className="mb-3 flex flex-col gap-1">
          <p className="text-xs text-muted">Event Subscriptions request URL</p>
          <CopyField
            label="events request URL"
            value={`${window.location.origin}${view.eventsPath}`}
          />
        </div>
      ) : null}
      {settings.isPending ? (
        <Placeholder className="h-24" />
      ) : settings.isError ? (
        <ErrorState error={settings.error} />
      ) : writable ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            connect.mutate(
              { botToken: botToken.trim(), signingSecret: signingSecret.trim() },
              {
                onSuccess: () => {
                  setBotToken('')
                  setSigningSecret('')
                  notify.success('Slack tokens saved')
                },
                onError: (error) => notify.error('Not saved', messageOf(error)),
              },
            )
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Bot User OAuth Token"
              type="password"
              value={botToken}
              onChange={setBotToken}
              placeholder="xoxb-…"
              autoComplete="off"
              mono
            />
            <TextField
              label="Signing Secret"
              type="password"
              value={signingSecret}
              onChange={setSigningSecret}
              autoComplete="off"
              mono
            />
          </div>
          <p className="text-xs text-muted">
            Both are sealed with the server's vault key and never shown again.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              isPending={connect.isPending}
              isDisabled={!botToken.trim() || !signingSecret.trim()}
            >
              <Save className="size-4" aria-hidden /> {view?.configured ? 'Replace' : 'Save'}
            </Button>
            {view?.configured ? (
              <Button variant="ghost" size="sm" onPress={() => setConfirming(true)}>
                <Trash2 className="size-4" aria-hidden /> Forget
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
      {view?.configured ? (
        writable ? (
          <SlackEmojiForm key={JSON.stringify(view.emoji)} view={view} />
        ) : (
          <SlackEmojiList view={view} />
        )
      ) : null}
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title="Forget the Slack credential?"
        confirmLabel="Forget"
        isPending={disconnect.isPending}
        onConfirm={() =>
          disconnect.mutate(undefined, {
            onSuccess: () => setConfirming(false),
            onError: (error) => notify.error('Not forgotten', messageOf(error)),
          })
        }
      >
        <p className="text-sm text-muted">
          The tokens and emoji overrides are deleted from the server.
        </p>
      </ConfirmDialog>
    </Panel>
  )
}
