import type { DigestList, DigestPreset, DigestView } from '@holtkeeper/api'
import { CalendarClock, FolderGit2, Plus, Send, SquarePen, Trash2 } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useDigestMutations, useDigests } from '../../api/queries.ts'
import { can } from '../../lib/access.ts'
import {
  type DigestDraft,
  digestDraft,
  draftInput,
  newDraft,
  presetDraft,
  targetsText,
} from '../../lib/digests.ts'
import { formatRelative } from '../../lib/format.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  ErrorState,
  Page,
  Placeholder,
  Switch,
  fadeItem,
  notify,
  stagger,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { DigestEditor } from './DigestEditor.tsx'
import { sourceIcon } from './sources.tsx'

const runTone = { sent: 'success', skipped: 'default', failed: 'danger' } as const

function scopeLine(digest: DigestView) {
  if (digest.scope.all) return 'All repositories'
  const groups = (digest.scope.groups ?? []).map((group) =>
    Array.isArray(group) ? group.join(' & ') : group,
  )
  return groups.join(', ') || 'No repositories'
}

function SourceChips({ sources, list }: { sources: readonly string[]; list: DigestList }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((kind) => {
        const Icon = sourceIcon(kind)
        const label = list.sources.find((source) => source.kind === kind)?.label ?? kind
        return (
          <span
            key={kind}
            className="inline-flex items-center gap-1.5 rounded-full bg-default/60 px-2.5 py-1 text-xs"
          >
            <Icon className="size-3.5 text-muted" aria-hidden />
            {label}
          </span>
        )
      })}
    </div>
  )
}

function PresetCard({
  preset,
  list,
  onPick,
}: {
  preset: DigestPreset
  list: DigestList
  onPick: () => void
}) {
  return (
    <motion.button
      {...fadeItem}
      type="button"
      onClick={onPick}
      whileHover={{ y: -2 }}
      className="flex flex-col gap-3 rounded-2xl bg-surface p-4 text-left shadow-surface transition hover:ring-1 hover:ring-accent/40"
    >
      <div>
        <div className="text-[15px] font-semibold">{preset.label}</div>
        <p className="mt-0.5 text-sm text-muted">{preset.description}</p>
      </div>
      <SourceChips sources={preset.input.sections.map((section) => section.source)} list={list} />
    </motion.button>
  )
}

function DigestCard({
  digest,
  list,
  userId,
  editable,
  onEdit,
  onDelete,
}: {
  digest: DigestView
  list: DigestList
  userId: string
  editable: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const { update, send } = useDigestMutations()
  const toggle = (enabled: boolean) =>
    update.mutate(
      {
        id: digest.id,
        input: draftInput({ ...digestDraft(digest, userId), enabled }, userId, digest),
      },
      { onError: (error) => notify.error('Not saved', messageOf(error)) },
    )
  const sendNow = () =>
    send.mutate(digest.id, {
      onSuccess: (run) =>
        run.status === 'failed'
          ? notify.error('Not delivered', run.errors.join('; '))
          : notify.success('Digest sent', `${run.items} items`),
      onError: (error) => notify.error('Not sent', messageOf(error)),
    })

  return (
    <motion.article
      {...fadeItem}
      className={`flex flex-col gap-4 rounded-2xl bg-surface p-4 shadow-surface transition ${
        digest.enabled ? '' : 'opacity-70'
      }`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{digest.name}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1">
              <CalendarClock className="size-3.5" aria-hidden />
              {digest.scheduleText} · {digest.schedule.timezone}
            </span>
            <span className="inline-flex items-center gap-1">
              <FolderGit2 className="size-3.5" aria-hidden />
              {scopeLine(digest)}
            </span>
          </p>
        </div>
        {editable ? (
          <Switch
            label=""
            isSelected={digest.enabled}
            onChange={toggle}
            isDisabled={update.isPending}
          />
        ) : null}
      </header>

      <SourceChips sources={digest.sections.map((section) => section.source)} list={list} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-default/60 pt-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>To {targetsText(digest.targets, userId)}</span>
          {digest.lastRun ? (
            <Chip tone={runTone[digest.lastRun.status]}>
              {digest.lastRun.status} {formatRelative(digest.lastRun.at)}
            </Chip>
          ) : null}
          {digest.nextRun ? <span>next {formatRelative(digest.nextRun)}</span> : null}
        </div>
        {editable ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onPress={sendNow} isPending={send.isPending}>
              <Send className="size-3.5" aria-hidden /> Send now
            </Button>
            <Button size="sm" variant="ghost" isIconOnly aria-label="Edit" onPress={onEdit}>
              <SquarePen className="size-4" aria-hidden />
            </Button>
            <Button size="sm" variant="ghost" isIconOnly aria-label="Delete" onPress={onDelete}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        ) : null}
      </div>
      {digest.lastRun?.errors.length ? (
        <p className="text-xs text-danger">{digest.lastRun.errors.join('; ')}</p>
      ) : null}
    </motion.article>
  )
}

/** Digests: scheduled summaries of what analyses found, delivered to Slack and panel chats. */
export function DigestsPage() {
  const digests = useDigests()
  const { remove } = useDigestMutations()
  const { principal } = useSession()
  const [editing, setEditing] = useState<{ draft: DigestDraft; digest?: DigestView }>()
  const [deleting, setDeleting] = useState<DigestView>()
  const editable = can(principal, 'settings:write')

  const list = digests.data
  const known = new Set(list?.sources.map((source) => source.kind) ?? [])

  return (
    <Page
      title="Digests"
      icon="activity"
      description="What the analyses found, collected on a schedule and sent where your team reads."
      actions={
        editable && list ? (
          <Button variant="primary" onPress={() => setEditing({ draft: newDraft() })}>
            <Plus className="size-4" aria-hidden /> New digest
          </Button>
        ) : null
      }
    >
      {digests.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Placeholder className="h-44" />
          <Placeholder className="h-44" />
        </div>
      ) : digests.isError || !list ? (
        <ErrorState error={digests.error} />
      ) : (
        <div className="flex flex-col gap-8">
          {list.digests.length ? (
            <motion.div {...stagger} className="grid gap-4 md:grid-cols-2">
              {list.digests.map((digest) => (
                <DigestCard
                  key={digest.id}
                  digest={digest}
                  list={list}
                  userId={principal.id}
                  editable={editable}
                  onEdit={() => setEditing({ draft: digestDraft(digest, principal.id), digest })}
                  onDelete={() => setDeleting(digest)}
                />
              ))}
            </motion.div>
          ) : null}

          {editable ? (
            <section className="flex flex-col gap-3">
              <div>
                <h2 className="text-base font-semibold">
                  {list.digests.length ? 'Start from a template' : 'Start with a template'}
                </h2>
                <p className="text-sm text-muted">
                  Pick one, adjust the repositories and where it goes, and see the result before
                  saving.
                </p>
              </div>
              <motion.div {...stagger} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {list.presets.map((preset) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    list={list}
                    onPick={() => setEditing({ draft: presetDraft(preset, known) })}
                  />
                ))}
              </motion.div>
            </section>
          ) : list.digests.length === 0 ? (
            <p className="text-sm text-muted">No digests yet.</p>
          ) : null}
        </div>
      )}

      {editing && list ? (
        <DigestEditor
          list={list}
          initial={editing.draft}
          digest={editing.digest}
          userId={principal.id}
          onClose={() => setEditing(undefined)}
        />
      ) : null}

      <ConfirmDialog
        isOpen={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined)
        }}
        title={`Delete ${deleting?.name ?? 'digest'}?`}
        isPending={remove.isPending}
        onConfirm={() => {
          if (deleting)
            remove.mutate(deleting.id, {
              onSuccess: () => setDeleting(undefined),
              onError: (error) => notify.error('Not deleted', messageOf(error)),
            })
        }}
      >
        <p className="text-sm text-muted">It stops going out; what it sent stays where it went.</p>
      </ConfirmDialog>
    </Page>
  )
}
