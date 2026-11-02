import type { Action, SlackChannelBinding, SlackSettingsView } from '@holtkeeper/api'
import { Hash, Lock } from 'lucide-react'
import { useMemo, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useGroups, useRepos, useSlackChannels } from '../../api/queries.ts'
import { repoKey } from '../../lib/repo.ts'
import { channelActionLabels, cleanBinding, newBinding, reposInScope } from '../../lib/slack.ts'
import {
  Button,
  Checkbox,
  Dialog,
  MultiToggle,
  Segmented,
  Select,
  TextField,
} from '../../ui/index.ts'

const NO_REPO = '__none'

/** Connects a channel, or changes what a connected one may do. */
export function ChannelDialog({
  settings,
  initial,
  onSave,
  onClose,
  saving,
}: {
  settings: SlackSettingsView
  initial?: SlackChannelBinding | undefined
  onSave: (binding: SlackChannelBinding) => void
  onClose: () => void
  saving: boolean
}) {
  const channels = useSlackChannels(true)
  const groups = useGroups()
  const repos = useRepos()
  const [binding, setBinding] = useState<SlackChannelBinding>(() => initial ?? newBinding('', ''))
  const set = (patch: Partial<SlackChannelBinding>) =>
    setBinding((current) => ({ ...current, ...patch }))

  const taken = new Set(settings.policy.channels.map((entry) => entry.channel))
  const available = (channels.data?.channels ?? []).filter(
    (channel) => channel.id === initial?.channel || !taken.has(channel.id),
  )
  const groupIds = useMemo(
    () => (groups.data?.entries ?? []).map((group) => group.id).toSorted(),
    [groups.data],
  )
  const selectedGroups = (binding.scope.groups ?? []).filter((group) => typeof group === 'string')
  const repoOptions = reposInScope(repos.data?.repos ?? [], binding.scope).map((summary) => ({
    id: repoKey(summary.repo),
    label: summary.repo.path,
  }))
  const valid =
    /^[CG][A-Z0-9]+$/.test(binding.channel) &&
    binding.name.trim() !== '' &&
    (binding.scope.all === true || selectedGroups.length > 0)

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={initial ? `#${initial.name}` : 'Connect a channel'}
      description="Commands in this channel reach only these repositories and actions, whatever the person writing may do elsewhere."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={!valid}
            isPending={saving}
            onPress={() => onSave(cleanBinding(binding, repos.data?.repos ?? []))}
          >
            {initial ? 'Save' : 'Connect channel'}
          </Button>
        </>
      }
    >
      {initial ? null : channels.isError ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-danger">{messageOf(channels.error)}</p>
          <TextField
            label="Channel id"
            value={binding.channel}
            onChange={(channel) => set({ channel: channel.trim(), name: binding.name || channel })}
            placeholder="C0123ABCD"
            description="In Slack: channel name → About → the id at the bottom."
            mono
          />
        </div>
      ) : (
        <Select
          label="Channel"
          placeholder={channels.isPending ? 'Loading channels…' : 'Pick a channel'}
          options={available.map((channel) => ({
            id: channel.id,
            text: channel.name,
            label: (
              <span className="inline-flex items-center gap-1.5">
                {channel.private ? (
                  <Lock className="size-3.5 text-muted" aria-hidden />
                ) : (
                  <Hash className="size-3.5 text-muted" aria-hidden />
                )}
                {channel.name}
                {channel.member ? null : (
                  <span className="text-xs text-muted">· bot not invited</span>
                )}
              </span>
            ),
          }))}
          value={binding.channel || undefined}
          onChange={(id) =>
            set({ channel: id, name: available.find((channel) => channel.id === id)?.name ?? id })
          }
        />
      )}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Repositories</span>
        <Segmented
          aria-label="Repositories"
          options={[
            { id: 'all', label: 'All' },
            { id: 'groups', label: 'Some groups' },
          ]}
          value={binding.scope.all ? 'all' : 'groups'}
          onChange={(value) =>
            set({ scope: value === 'all' ? { all: true } : { groups: selectedGroups } })
          }
        />
        {binding.scope.all ? null : groupIds.length ? (
          <MultiToggle
            aria-label="Groups"
            options={groupIds.map((id) => ({ id, label: id }))}
            value={selectedGroups}
            onChange={(next) => set({ scope: { groups: next } })}
          />
        ) : (
          <p className="text-xs text-muted">No groups are configured yet.</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Allowed here</span>
        <div className="grid gap-2 sm:grid-cols-2">
          {settings.actions.map((action: Action) => (
            <div key={action} className="rounded-xl bg-default/40 px-3 py-2">
              <Checkbox
                label={channelActionLabels[action]?.label ?? action}
                isSelected={binding.actions.includes(action)}
                onChange={(selected) =>
                  set({
                    actions: selected
                      ? [...binding.actions, action]
                      : binding.actions.filter((entry) => entry !== action),
                  })
                }
              />
              <p className="mt-0.5 pl-7 text-xs text-muted">
                {channelActionLabels[action]?.description}
              </p>
            </div>
          ))}
        </div>
      </div>

      <Select
        label="Default repository"
        options={[{ id: NO_REPO, label: 'None: commands name one' }, ...repoOptions]}
        value={binding.defaultRepo ?? NO_REPO}
        onChange={(id) => {
          const { defaultRepo: _dropped, ...rest } = binding
          setBinding(id === NO_REPO ? rest : { ...rest, defaultRepo: id })
        }}
      />
      <p className="-mt-2 text-xs text-muted">
        Commands like <code className="font-mono">release</code> use it when they name no
        repository, so the channel of one product can just say{' '}
        <code className="font-mono">/holtkeeper release</code>.
      </p>
    </Dialog>
  )
}
