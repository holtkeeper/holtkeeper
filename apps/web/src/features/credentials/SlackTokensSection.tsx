import { Save, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useSlackMutations, useSlackSettings } from '../../api/queries.ts'
import { formatRelative } from '../../lib/format.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  ErrorState,
  Panel,
  Placeholder,
  TextField,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

/** The stored Slack app tokens: whether they are set, and a form to replace or forget them. */
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
      description="Bot token and signing secret of a Slack app, kept for a future integration. Nothing uses them yet."
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
              variant="primary"
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
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title="Forget the Slack tokens?"
        confirmLabel="Forget"
        isPending={disconnect.isPending}
        onConfirm={() =>
          disconnect.mutate(undefined, {
            onSuccess: () => setConfirming(false),
            onError: (error) => notify.error('Not forgotten', messageOf(error)),
          })
        }
      >
        <p className="text-sm text-muted">They are deleted from the server.</p>
      </ConfirmDialog>
    </Panel>
  )
}
