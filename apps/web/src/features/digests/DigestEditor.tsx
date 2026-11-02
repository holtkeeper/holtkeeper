import type { DigestList, DigestView } from '@holtkeeper/api'
import { CalendarClock, Check, Eye, Hash, MessagesSquare } from 'lucide-react'
import { motion } from 'motion/react'
import { useMemo, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useDigestMutations, useDigestPreview, useGroups } from '../../api/queries.ts'
import {
  type DigestDraft,
  draftInput,
  draftProblems,
  editSection,
  sourceDescription,
  timezoneOptions,
  toggleSection,
  weekdayOptions,
} from '../../lib/digests.ts'
import { formatRelative } from '../../lib/format.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import {
  Button,
  Dialog,
  MultiToggle,
  Placeholder,
  Segmented,
  Select,
  Switch,
  TagInput,
  TextField,
  notify,
} from '../../ui/index.ts'
import { ChatCard } from '../chat/ChatCard.tsx'
import { sourceIcon } from './sources.tsx'

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

const tones = [
  { id: 'info' as const, label: 'Everything' },
  { id: 'warning' as const, label: 'Warnings' },
  { id: 'bad' as const, label: 'Problems' },
]

const limits = ['3', '5', '8', '15', '30']

function SourceTile({
  kind,
  label,
  draft,
  onChange,
}: {
  kind: string
  label: string
  draft: DigestDraft
  onChange: (draft: DigestDraft) => void
}) {
  const Icon = sourceIcon(kind)
  const selected = draft.sections.find((entry) => entry.source === kind)
  return (
    <motion.div
      layout
      className={`flex flex-col gap-3 rounded-2xl p-3 transition ${
        selected ? 'bg-accent-soft ring-1 ring-accent/40' : 'bg-default/40 hover:bg-default/70'
      }`}
    >
      <button
        type="button"
        className="flex items-start gap-3 text-left"
        aria-pressed={selected !== undefined}
        onClick={() => onChange(toggleSection(draft, kind))}
      >
        <span
          className={`grid size-9 shrink-0 place-items-center rounded-xl ${
            selected ? 'bg-accent text-accent-foreground' : 'bg-surface text-muted'
          }`}
        >
          {selected ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Icon className="size-4" aria-hidden />
          )}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">{label}</span>
          <span className="block text-xs text-muted">{sourceDescription(kind)}</span>
        </span>
      </button>
      {selected ? (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            aria-label={`${label}: what to include`}
            options={tones}
            value={selected.minTone}
            onChange={(minTone) => onChange(editSection(draft, kind, { minTone }))}
          />
          <Select
            aria-label={`${label}: items shown`}
            className="w-24"
            options={limits.map((limit) => ({ id: limit, label: `Top ${limit}` }))}
            value={String(selected.limit)}
            onChange={(limit) => onChange(editSection(draft, kind, { limit: Number(limit) }))}
          />
        </div>
      ) : null}
    </motion.div>
  )
}

function Preview({
  list,
  draft,
  digest,
  userId,
}: {
  list: DigestList
  draft: DigestDraft
  digest: DigestView | undefined
  userId: string
}) {
  const ready = draftProblems(draft).length === 0
  const input = useDebounced(ready ? draftInput(draft, userId, digest) : undefined, 400)
  const preview = useDigestPreview(input, digest?.id)
  return (
    <div className="flex flex-col gap-3 lg:sticky lg:top-0">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Eye className="size-4 text-muted" aria-hidden /> Preview
        </span>
        {preview.data ? (
          <span className="text-xs text-muted">
            {preview.data.items} items · {preview.data.repos} repositories
          </span>
        ) : null}
      </div>
      {preview.data ? (
        <div className="flex items-center gap-2 rounded-xl bg-default/40 px-3 py-2 text-xs text-muted">
          <CalendarClock className="size-3.5 shrink-0" aria-hidden />
          <span>
            {preview.data.scheduleText}
            {preview.data.nextRun ? ` · next ${formatRelative(preview.data.nextRun)}` : ''}
          </span>
        </div>
      ) : null}
      {!ready ? (
        <div className="rounded-2xl border border-dashed border-default p-6 text-center text-sm text-muted">
          {draftProblems(draft).join(' · ')}
        </div>
      ) : preview.isError ? (
        <p className="text-sm text-danger">{messageOf(preview.error)}</p>
      ) : preview.data ? (
        <div className={preview.isFetching ? 'opacity-60 transition' : 'transition'}>
          <ChatCard card={preview.data.card} busy onRun={() => {}} />
        </div>
      ) : (
        <Placeholder className="h-64" />
      )}
      {list.sources.length === 0 ? (
        <p className="text-xs text-muted">This server has no analyses yet to build digests from.</p>
      ) : null}
    </div>
  )
}

/** Creates or changes a digest, with a live preview of what it would send now. */
export function DigestEditor({
  list,
  initial,
  digest,
  userId,
  onClose,
}: {
  list: DigestList
  initial: DigestDraft
  digest?: DigestView | undefined
  userId: string
  onClose: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const groups = useGroups()
  const { create, update } = useDigestMutations()
  const set = <K extends keyof DigestDraft>(key: K, value: DigestDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))
  const problems = draftProblems(draft)
  const groupIds = useMemo(
    () =>
      [...new Set([...(groups.data?.entries ?? []).map((g) => g.id), ...draft.groups])].toSorted(),
    [groups.data, draft.groups],
  )
  const saving = create.isPending || update.isPending

  const save = () => {
    const input = draftInput(draft, userId, digest)
    const done = {
      onSuccess: () => {
        notify.success(digest ? 'Digest saved' : 'Digest created')
        onClose()
      },
      onError: (error: unknown) => notify.error('Not saved', messageOf(error)),
    }
    if (digest) update.mutate({ id: digest.id, input }, done)
    else create.mutate(input, done)
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={digest ? `Edit ${digest.name}` : 'New digest'}
      description="Collects what the latest analyses found and sends it on a schedule."
      size="xl"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <Switch
            label="Enabled"
            isSelected={draft.enabled}
            onChange={(enabled) => set('enabled', enabled)}
          />
          <div className="flex items-center gap-2">
            <Button variant="ghost" onPress={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onPress={save}
              isPending={saving}
              isDisabled={problems.length > 0}
            >
              {digest ? 'Save' : 'Create digest'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="flex flex-col gap-7">
          <TextField
            label="Name"
            value={draft.name}
            onChange={(name) => set('name', name)}
            placeholder="Weekly compliance"
            autoFocus={!digest}
          />

          <Section title="Covers" hint="Repositories whose latest analyses are read.">
            <Segmented
              aria-label="Repositories"
              options={[
                { id: 'all', label: 'All repositories' },
                { id: 'groups', label: 'Some groups' },
              ]}
              value={draft.all ? 'all' : 'groups'}
              onChange={(value) => set('all', value === 'all')}
            />
            {draft.all ? null : groupIds.length ? (
              <MultiToggle
                aria-label="Groups"
                options={groupIds.map((id) => ({ id, label: id }))}
                value={draft.groups}
                onChange={(next) => set('groups', next)}
              />
            ) : (
              <p className="text-xs text-muted">No groups are configured yet.</p>
            )}
          </Section>

          <Section title="When">
            <Segmented
              aria-label="How often"
              options={[
                { id: 'day' as const, label: 'Daily' },
                { id: 'week' as const, label: 'Weekly' },
                { id: 'month' as const, label: 'Monthly' },
              ]}
              value={draft.every}
              onChange={(every) => set('every', every)}
            />
            <div className="flex flex-wrap items-end gap-3">
              {draft.every === 'month' ? (
                <Select
                  label="Day of the month"
                  className="w-36"
                  options={Array.from({ length: 28 }, (_, index) => ({
                    id: String(index + 1),
                    label: String(index + 1),
                  }))}
                  value={String(draft.dayOfMonth)}
                  onChange={(day) => set('dayOfMonth', Number(day))}
                />
              ) : (
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Days</span>
                  <MultiToggle
                    aria-label="Days"
                    options={weekdayOptions}
                    value={draft.days}
                    onChange={(days) => set('days', days)}
                  />
                </div>
              )}
              <TextField
                label="Time"
                className="w-24"
                value={draft.time}
                onChange={(time) => set('time', time)}
                placeholder="09:30"
                mono
              />
              <Select
                label="Time zone"
                className="w-52"
                options={timezoneOptions(draft.timezone).map((zone) => ({ id: zone, label: zone }))}
                value={draft.timezone}
                onChange={(timezone) => set('timezone', timezone)}
              />
            </div>
          </Section>

          <Section
            title="Sections"
            hint="Each one lists the issues of the latest reports of an analysis."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {list.sources.map((source) => (
                <SourceTile
                  key={source.kind}
                  kind={source.kind}
                  label={source.label}
                  draft={draft}
                  onChange={setDraft}
                />
              ))}
            </div>
          </Section>

          <Section title="Rules">
            <Switch
              label="Only what is new since the last digest"
              description="An issue is listed once; it comes back only after it was fixed and appeared again."
              isSelected={draft.onlyNew}
              onChange={(onlyNew) => set('onlyNew', onlyNew)}
            />
            <Switch
              label="Skip when there is nothing to report"
              isSelected={draft.skipEmpty}
              onChange={(skipEmpty) => set('skipEmpty', skipEmpty)}
            />
          </Section>

          <Section title="Deliver to">
            <Switch
              label={
                <span className="inline-flex items-center gap-1.5">
                  <MessagesSquare className="size-4 text-muted" aria-hidden /> My chat in the panel
                </span>
              }
              isSelected={draft.panel}
              onChange={(panel) => set('panel', panel)}
            />
            <TagInput
              label={
                <span className="inline-flex items-center gap-1.5">
                  <Hash className="size-4 text-muted" aria-hidden /> Slack channels
                </span>
              }
              values={draft.slackChannels}
              onChange={(channels) => set('slackChannels', channels)}
              placeholder="releases"
              description={
                list.slack
                  ? 'Channel names or ids; invite the Holtkeeper bot to each of them.'
                  : 'Slack is not configured on this server (chat.slack), so these are not delivered.'
              }
            />
          </Section>
        </div>

        <Preview list={list} draft={draft} digest={digest} userId={userId} />
      </div>
    </Dialog>
  )
}
