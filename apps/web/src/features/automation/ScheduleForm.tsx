import type { ConfigEntryView } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useConfigMutations, useScheduleRuns } from '../../api/queries.ts'
import {
  type ScheduleDraft,
  describeWindows,
  toScheduleDraft,
  toScheduleInput,
  validateScheduleDraft,
} from '../../lib/automation.ts'
import { Notice, Segmented, Switch, TagInput, TextField, notify } from '../../ui/index.ts'
import { RuleForm } from './RuleForm.tsx'
import { LastRun, RunHistory, RunNowButton } from './ScheduleRuns.tsx'
import { AnalyzerPicker, GroupPicker, NextRuns, RemoveEntryDialog } from './shared.tsx'

const cadences = [
  { id: 'every', label: 'Every' },
  { id: 'cron', label: 'Cron' },
] as const

/**
 * Edits a schedule in the rule drawer, or adds one when `entry` is absent. Allow and deny
 * windows and holidays of older schedules are kept as they are.
 */
export function ScheduleForm({
  entry,
  taken,
  writable,
  runnable,
  onDone,
}: {
  entry?: ConfigEntryView<'schedule'>
  taken: readonly string[]
  writable: boolean
  /** The viewer may run it now. */
  runnable: boolean
  onDone: () => void
}) {
  const isNew = entry === undefined
  const [draft, setDraft] = useState<ScheduleDraft>(() => toScheduleDraft(entry))
  const [submitted, setSubmitted] = useState(false)
  const [removing, setRemoving] = useState(false)
  const { put } = useConfigMutations('schedules')
  const runs = useScheduleRuns()
  const errors = submitted ? validateScheduleDraft(draft, isNew ? taken : []) : {}
  const set = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const kept = describeWindows({
    ...(draft.allow.length ? { allow: draft.allow } : {}),
    ...(draft.deny.length ? { deny: draft.deny } : {}),
    ...(draft.holidays.length ? { holidays: draft.holidays } : {}),
  })
  const history = entry ? runs.data?.schedules.find((s) => s.id === entry.id)?.runs : undefined

  const save = () => {
    setSubmitted(true)
    if (Object.keys(validateScheduleDraft(draft, isNew ? taken : [])).length) return
    const id = draft.id.trim()
    put.mutate(
      { id, data: toScheduleInput(draft) },
      {
        onSuccess: () => {
          notify.success(isNew ? 'Schedule added' : 'Schedule saved', id)
          onDone()
        },
      },
    )
  }

  return (
    <>
      <RuleForm
        writable={writable}
        isPending={put.isPending}
        onSave={save}
        {...(entry ? { onRemove: () => setRemoving(true) } : {})}
        notice={
          put.error ? (
            <Notice tone="danger" title="Not saved">
              {messageOf(put.error)}
            </Notice>
          ) : null
        }
        footer={
          entry && runnable ? (
            <RunNowButton id={entry.id} name={entry.data.name || entry.id} />
          ) : null
        }
        when={
          <>
            {isNew ? (
              <TextField
                label="Id"
                value={draft.id}
                onChange={(v) => set('id', v)}
                error={errors.id}
                mono
                isRequired
                placeholder="weekly-check"
              />
            ) : null}
            <TextField
              label="Name"
              value={draft.name}
              onChange={(v) => set('name', v)}
              placeholder={draft.id || 'Weekly check'}
            />
            <Segmented
              aria-label="Cadence"
              options={cadences}
              value={draft.cadence}
              onChange={(v) => set('cadence', v)}
            />
            {draft.cadence === 'every' ? (
              <TextField
                label="Interval"
                value={draft.every}
                onChange={(v) => set('every', v)}
                error={errors.every}
                mono
                placeholder="1d"
              />
            ) : (
              <TextField
                label="Cron"
                value={draft.cron}
                onChange={(v) => set('cron', v)}
                error={errors.cron}
                mono
                placeholder="0 3 * * 1-5"
              />
            )}
            <TextField
              label="Time zone"
              value={draft.timezone}
              onChange={(v) => set('timezone', v)}
              error={errors.timezone}
              placeholder="The instance's"
            />
            {entry ? (
              <div className="flex flex-wrap items-start gap-6">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted">Next runs</span>
                  <NextRuns id={entry.id} />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted">Last run</span>
                  <LastRun id={entry.id} run={history?.[0]} />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted">Earlier runs</span>
                  <RunHistory runs={history ?? []} />
                </div>
              </div>
            ) : null}
          </>
        }
        where={
          <>
            <GroupPicker
              value={draft.groups}
              onChange={(v) => set('groups', v)}
              description="None selected: every repository."
            />
            <TagInput
              label="Only these repositories"
              values={draft.repos}
              onChange={(v) => set('repos', v)}
              placeholder="work:toys/*"
              description={
                errors.repos ?? 'forge:path globs; none means every repository of the groups.'
              }
            />
          </>
        }
        condition={
          <>
            <Switch
              label="Skip weekends"
              isSelected={draft.skipWeekends}
              onChange={(v) => set('skipWeekends', v)}
            />
            <Switch
              label="Skip nights"
              isSelected={draft.skipNights}
              onChange={(v) => set('skipNights', v)}
            />
            {draft.skipNights ? (
              <div className="grid grid-cols-2 gap-2">
                <TextField
                  label="From"
                  value={draft.nightFrom}
                  onChange={(v) => set('nightFrom', v)}
                  error={errors.nights}
                  mono
                />
                <TextField
                  label="To"
                  value={draft.nightTo}
                  onChange={(v) => set('nightTo', v)}
                  mono
                />
              </div>
            ) : null}
            {kept.length ? (
              <p className="text-xs text-muted">Kept as stored: {kept.join(', ')}.</p>
            ) : null}
          </>
        }
        then={
          <AnalyzerPicker
            label="Analyzers"
            value={draft.analyzers}
            onChange={(v) => set('analyzers', v)}
            error={errors.analyzers}
          />
        }
        limits={
          <>
            <Switch
              label="Enabled"
              isSelected={draft.enabled}
              onChange={(v) => set('enabled', v)}
            />
            <TextField
              label="Jitter (minutes)"
              value={draft.jitterMinutes}
              onChange={(v) => set('jitterMinutes', v)}
              error={errors.jitterMinutes}
              placeholder="0"
            />
            <Switch
              label="Spread repository jobs over the allowed window"
              isSelected={draft.spread}
              onChange={(v) => set('spread', v)}
            />
          </>
        }
      />
      <RemoveEntryDialog
        collection="schedules"
        entry={removing && entry ? entry : null}
        noun="schedule"
        onClose={() => setRemoving(false)}
        onRemoved={onDone}
      />
    </>
  )
}
