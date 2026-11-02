import type { SlackChannelView } from '@holtkeeper/api'
import { Check, Hash, Lock } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useSlackChannels } from '../../api/queries.ts'
import { channelMatches } from '../../lib/slack.ts'
import { Button, Placeholder, SearchInput, TextField } from '../../ui/index.ts'

/**
 * Picks a Slack channel: a searchable list from Slack (channels the bot is in first), or its id
 * typed in when the channel is not listed or listing fails.
 */
export function ChannelPicker({
  value,
  taken,
  onPick,
}: {
  value: string
  /** Channels already connected; left out. */
  taken: ReadonlySet<string>
  onPick: (channel: { id: string; name: string }) => void
}) {
  const channels = useSlackChannels(true)
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState(false)
  const all = (channels.data?.channels ?? []).filter((channel) => !taken.has(channel.id))
  const shown = channelMatches(all, query)

  if (manual || channels.isError)
    return (
      <div className="flex flex-col gap-2">
        {channels.isError ? (
          <p className="text-sm text-danger">{messageOf(channels.error)}</p>
        ) : null}
        <TextField
          label="Channel id"
          value={value}
          onChange={(id) => onPick({ id: id.trim(), name: id.trim() })}
          placeholder="C0123ABCD"
          description="In Slack: open the channel → its name at the top → the id at the bottom of About."
          mono
          autoFocus
        />
        {channels.isError ? null : (
          <button
            type="button"
            className="self-start text-xs text-accent hover:underline"
            onClick={() => setManual(false)}
          >
            Back to the list
          </button>
        )}
      </div>
    )

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Channel</span>
      <SearchInput
        aria-label="Search channels"
        placeholder={channels.isPending ? 'Loading channels…' : `Search ${all.length} channels`}
        value={query}
        onChange={setQuery}
      />
      {channels.isPending ? (
        <Placeholder className="h-40" />
      ) : (
        <div
          role="listbox"
          aria-label="Channels"
          className="flex max-h-64 flex-col overflow-y-auto rounded-xl bg-default/40 p-1"
        >
          {shown.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted">
              {query ? `No channel matches “${query}”.` : 'No channels to connect.'}
            </p>
          ) : (
            shown.map((channel: SlackChannelView) => {
              const selected = channel.id === value
              return (
                <button
                  key={channel.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => onPick({ id: channel.id, name: channel.name })}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                    selected ? 'bg-accent-soft text-accent-soft-foreground' : 'hover:bg-default/70'
                  }`}
                >
                  {channel.private ? (
                    <Lock className="size-3.5 shrink-0 text-muted" aria-hidden />
                  ) : (
                    <Hash className="size-3.5 shrink-0 text-muted" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                  {channel.member ? null : (
                    <span className="shrink-0 text-xs text-muted">bot not invited</span>
                  )}
                  {selected ? <Check className="size-4 shrink-0" aria-hidden /> : null}
                </button>
              )
            })
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          Private channels show up once the bot is invited (
          <code className="font-mono">/invite @bot</code>).
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onPress={() => void channels.refetch()}
            isPending={channels.isFetching}
          >
            Refresh
          </Button>
          <Button size="sm" variant="ghost" onPress={() => setManual(true)}>
            Enter an id
          </Button>
        </div>
      </div>
    </div>
  )
}
