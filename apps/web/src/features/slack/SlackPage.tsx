import type { SlackChannelBinding, SlackPolicy, SlackSettingsView } from '@holtkeeper/api'
import {
  CircleCheck,
  ExternalLink,
  Hash,
  Link2,
  Plug,
  Plus,
  SquarePen,
  Trash2,
  Unplug,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useSlackMutations, useSlackSettings } from '../../api/queries.ts'
import { formatRelative } from '../../lib/format.ts'
import { channelActionLabel, scopeSummary, withBinding } from '../../lib/slack.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  CopyField,
  ErrorState,
  Notice,
  Page,
  Panel,
  Placeholder,
  Segmented,
  Switch,
  TextField,
  buttonClass,
  fadeItem,
  notify,
  stagger,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { ChannelDialog } from './ChannelDialog.tsx'

function Step({
  index,
  title,
  done,
  children,
}: {
  index: number
  title: string
  done?: boolean
  children: React.ReactNode
}) {
  return (
    <motion.li {...fadeItem} className="relative flex gap-4 pb-6 last:pb-0">
      <span
        aria-hidden
        className="absolute top-9 bottom-0 left-[15px] w-px bg-default [li:last-child>&]:hidden"
      />
      <span
        className={`relative grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${
          done ? 'bg-success text-white' : 'bg-accent-soft text-accent-soft-foreground'
        }`}
      >
        {done ? <CircleCheck className="size-4" aria-hidden /> : index}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex flex-col gap-2 text-sm text-muted">{children}</div>
      </div>
    </motion.li>
  )
}

function Manifest({ manifest }: { manifest: unknown }) {
  const [open, setOpen] = useState(false)
  const text = JSON.stringify(manifest, null, 2)
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="self-start text-xs text-accent hover:underline"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide the manifest' : 'Or paste the manifest yourself'}
      </button>
      {open ? (
        <div className="relative">
          <pre className="max-h-72 overflow-auto rounded-xl bg-default p-3 font-mono text-[12px] text-foreground">
            {text}
          </pre>
          <Button
            size="sm"
            variant="secondary"
            className="absolute top-2 right-2"
            onPress={() =>
              void navigator.clipboard.writeText(text).then(() => notify.success('Manifest copied'))
            }
          >
            Copy
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function SetupGuide({ settings, editable }: { settings: SlackSettingsView; editable: boolean }) {
  const { connect } = useSlackMutations()
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const connected = settings.source !== 'none'
  return (
    <Panel
      title="Set up the Slack app"
      description="Once per workspace; then connect channels below."
    >
      <motion.ol {...stagger} className="flex flex-col">
        <Step index={1} title="Create the app from our manifest" done={connected}>
          <p>
            Opens Slack with everything filled in: the bot, the{' '}
            <code className="font-mono">/holtkeeper</code> command, events and buttons pointing at
            this server. Pick your workspace and press <b>Create</b>.
          </p>
          <a
            href={settings.createAppUrl}
            target="_blank"
            rel="noreferrer noopener"
            className={buttonClass('primary', 'sm', 'self-start')}
          >
            Create app in Slack <ExternalLink className="size-3.5" aria-hidden />
          </a>
          <Manifest manifest={settings.manifest} />
        </Step>
        <Step index={2} title="Install it to the workspace" done={connected}>
          <p>
            In the app: <b>Install App → Install to Workspace</b>, allow it, then copy the{' '}
            <b>Bot User OAuth Token</b> (starts with <code className="font-mono">xoxb-</code>).
          </p>
        </Step>
        <Step index={3} title="Copy the signing secret" done={connected}>
          <p>
            <b>Basic Information → App Credentials → Signing Secret</b>. Holtkeeper checks every
            request from Slack with it.
          </p>
        </Step>
        <Step index={4} title="Connect" done={connected}>
          {settings.source === 'file' ? (
            <p>Connected through the config file (chat.slack).</p>
          ) : connected ? (
            <p>
              Connected to <b className="text-foreground">{settings.workspace?.team}</b>.
            </p>
          ) : editable ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                connect.mutate(
                  { botToken: botToken.trim(), signingSecret: signingSecret.trim() },
                  {
                    onSuccess: (view) => notify.success('Slack connected', view.workspace?.team),
                    onError: (error) => notify.error('Not connected', messageOf(error)),
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
              <p className="text-xs">
                Both are sealed with the server's vault key and never shown again.
              </p>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                className="self-start"
                isPending={connect.isPending}
                isDisabled={!botToken.trim() || !signingSecret.trim()}
              >
                <Plug className="size-4" aria-hidden /> Connect
              </Button>
            </form>
          ) : (
            <p>Someone with settings:write connects it.</p>
          )}
        </Step>
        <Step index={5} title="Invite the bot and link accounts">
          <p>
            In each channel the bot should answer in, run{' '}
            <code className="font-mono">/invite @{settings.workspace?.bot ?? 'holtkeeper'}</code>{' '}
            and connect the channel below. People send the bot{' '}
            <code className="font-mono">link</code> in a direct message once: it answers with a
            private link that ties their Slack account to their Holtkeeper user.
          </p>
        </Step>
      </motion.ol>
    </Panel>
  )
}

function Connection({ settings, editable }: { settings: SlackSettingsView; editable: boolean }) {
  const { disconnect } = useSlackMutations()
  const [confirming, setConfirming] = useState(false)
  const { workspace } = settings
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-success-soft text-success">
            <Link2 className="size-5" aria-hidden />
          </span>
          <div>
            <div className="text-base font-semibold">
              {workspace ? workspace.team : 'Slack'}{' '}
              <Chip tone="success">{settings.source === 'file' ? 'config file' : 'connected'}</Chip>
            </div>
            <p className="text-sm text-muted">
              {workspace ? `as @${workspace.bot}` : 'The bot did not answer auth.test'}
              {settings.connectedAt ? ` · since ${formatRelative(settings.connectedAt)}` : ''}
              {workspace?.url ? (
                <>
                  {' · '}
                  <a
                    href={workspace.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent hover:underline"
                  >
                    open workspace
                  </a>
                </>
              ) : null}
            </p>
          </div>
        </div>
        {editable && settings.source === 'panel' ? (
          <Button variant="ghost" size="sm" onPress={() => setConfirming(true)}>
            <Unplug className="size-4" aria-hidden /> Disconnect
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title="Disconnect Slack?"
        confirmLabel="Disconnect"
        isPending={disconnect.isPending}
        onConfirm={() =>
          disconnect.mutate(undefined, {
            onSuccess: () => setConfirming(false),
            onError: (error) => notify.error('Not disconnected', messageOf(error)),
          })
        }
      >
        <p className="text-sm text-muted">
          The bot stops answering and digests stop reaching Slack. Channel settings stay for when
          you connect again.
        </p>
      </ConfirmDialog>
    </Panel>
  )
}

function Channels({ settings, editable }: { settings: SlackSettingsView; editable: boolean }) {
  const { savePolicy } = useSlackMutations()
  const [editing, setEditing] = useState<{ binding?: SlackChannelBinding }>()
  const [removing, setRemoving] = useState<SlackChannelBinding>()
  const save = (policy: SlackPolicy, done?: () => void) =>
    savePolicy.mutate(policy, {
      onSuccess: () => done?.(),
      onError: (error) => notify.error('Not saved', messageOf(error)),
    })
  const { policy } = settings
  return (
    <Panel
      title="Channels"
      description="One bot, many channels: each reaches its own repositories and actions."
      actions={
        editable ? (
          <Button size="sm" variant="primary" onPress={() => setEditing({})}>
            <Plus className="size-4" aria-hidden /> Connect channel
          </Button>
        ) : null
      }
    >
      {policy.channels.length === 0 ? (
        <p className="py-4 text-sm text-muted">
          No channels yet. Connect the ones where people run commands; digests can post to any
          public channel either way.
        </p>
      ) : (
        <motion.ul {...stagger} className="flex flex-col divide-y divide-default/60">
          {policy.channels.map((binding) => (
            <motion.li
              key={binding.channel}
              {...fadeItem}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-default/60">
                  <Hash className="size-4 text-muted" aria-hidden />
                </span>
                <div className="min-w-0">
                  <div className="font-medium">{binding.name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span>{scopeSummary(binding.scope)}</span>
                    {binding.defaultRepo ? (
                      <span>· default {binding.defaultRepo.split(':')[1]}</span>
                    ) : null}
                    {binding.actions.length ? (
                      binding.actions.map((action) => (
                        <Chip key={action} tone="accent">
                          {channelActionLabel(action)}
                        </Chip>
                      ))
                    ) : (
                      <Chip>nothing allowed</Chip>
                    )}
                  </div>
                </div>
              </div>
              {editable ? (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label="Edit"
                    onPress={() => setEditing({ binding })}
                  >
                    <SquarePen className="size-4" aria-hidden />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label="Remove"
                    onPress={() => setRemoving(binding)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </div>
              ) : null}
            </motion.li>
          ))}
        </motion.ul>
      )}

      {editing ? (
        <ChannelDialog
          settings={settings}
          initial={editing.binding}
          saving={savePolicy.isPending}
          onClose={() => setEditing(undefined)}
          onSave={(binding) =>
            save({ ...policy, channels: withBinding(policy.channels, binding) }, () =>
              setEditing(undefined),
            )
          }
        />
      ) : null}
      <ConfirmDialog
        isOpen={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined)
        }}
        title={`Disconnect #${removing?.name ?? ''}?`}
        confirmLabel="Disconnect"
        isPending={savePolicy.isPending}
        onConfirm={() =>
          save(
            {
              ...policy,
              channels: policy.channels.filter((entry) => entry.channel !== removing?.channel),
            },
            () => setRemoving(undefined),
          )
        }
      >
        <p className="text-sm text-muted">
          Commands there follow the rule for other channels below.
        </p>
      </ConfirmDialog>
    </Panel>
  )
}

function Elsewhere({ settings, editable }: { settings: SlackSettingsView; editable: boolean }) {
  const { savePolicy } = useSlackMutations()
  const { policy } = settings
  const save = (next: SlackPolicy) =>
    savePolicy.mutate(next, { onError: (error) => notify.error('Not saved', messageOf(error)) })
  return (
    <Panel title="Everywhere else">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Channels that are not connected</span>
          <Segmented
            aria-label="Channels that are not connected"
            options={[
              { id: 'deny' as const, label: 'Refuse commands' },
              { id: 'user' as const, label: 'Use the person’s own access' },
            ]}
            value={policy.unboundChannels}
            onChange={(unboundChannels) => {
              if (editable) save({ ...policy, unboundChannels })
            }}
          />
          <p className="text-xs text-muted">
            {policy.unboundChannels === 'deny'
              ? 'The bot only works in connected channels and direct messages.'
              : 'Anyone with a linked account can run what their own grants allow, in any channel the bot is in.'}
          </p>
        </div>
        <Switch
          label="Direct messages with the bot"
          description="With the person's own access; needed for linking accounts."
          isSelected={policy.directMessages}
          isDisabled={!editable || savePolicy.isPending}
          onChange={(directMessages) => save({ ...policy, directMessages })}
        />
      </div>
    </Panel>
  )
}

function RequestUrls({ settings }: { settings: SlackSettingsView }) {
  return (
    <Panel
      title="Request URLs"
      description="Already in the manifest; for apps created by hand or after the address changed."
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1 text-xs text-muted">
          <span>Event Subscriptions</span>
          <CopyField value={settings.urls.events} label="events URL" />
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          <span>Slash command /holtkeeper</span>
          <CopyField value={settings.urls.commands} label="commands URL" />
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          <span>Interactivity</span>
          <CopyField value={settings.urls.interactions} label="interactions URL" />
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {settings.scopes.map((entry) => (
            <span
              key={entry.scope}
              title={entry.why}
              className="rounded-full bg-default/60 px-2.5 py-1 font-mono text-[11px] text-muted"
            >
              {entry.scope}
            </span>
          ))}
        </div>
      </div>
    </Panel>
  )
}

/** Connects the Slack app and decides what each channel may do. */
export function SlackPage() {
  const settings = useSlackSettings()
  const { can } = useSession()
  const editable = can('settings:write')
  const view = settings.data
  return (
    <Page
      title="Slack"
      icon="slack"
      description="Commands, buttons and digests in Slack, with each channel limited to its own repositories."
    >
      {settings.isPending ? (
        <Placeholder className="h-96" />
      ) : settings.isError || !view ? (
        <ErrorState error={settings.error} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <div className="flex flex-col gap-6">
            {view.source === 'none' ? null : <Connection settings={view} editable={editable} />}
            {view.source === 'none' ? null : <Channels settings={view} editable={editable} />}
            <SetupGuide settings={view} editable={editable} />
          </div>
          <div className="flex flex-col gap-6">
            {view.source === 'none' ? (
              <Notice title="Not connected yet">
                Follow the steps to create the app, then paste its token and signing secret.
              </Notice>
            ) : (
              <Elsewhere settings={view} editable={editable} />
            )}
            <RequestUrls settings={view} />
          </div>
        </div>
      )}
    </Page>
  )
}
