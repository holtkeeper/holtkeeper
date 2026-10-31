import type { ConfigEntryView, JobAnalyzerView, Weekday } from '@holtkeeper/api'
import { Plus, X } from 'lucide-react'
import { useCallback, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useConfigEntry, useConfigMutations, useJobAnalyzers } from '../../api/queries.ts'
import {
  type ScheduleDraft,
  type WindowDraft,
  dayLabel,
  describeCadence,
  isIsoDate,
  newWindow,
  toScheduleDraft,
  toScheduleInput,
  validateScheduleDraft,
  weekdays,
} from '../../lib/automation.ts'
import {
  Button,
  Dialog,
  MultiToggle,
  Notice,
  Segmented,
  Switch,
  TagInput,
  TextField,
  notify,
} from '../../ui/index.ts'
import { StructuredEditor } from '../settings/SchemaField.tsx'
import { AnalyzerPicker, EntryHistory, FormSection, GroupPicker, NextRuns } from './shared.tsx'

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone

/** Creates a panel schedule or edits one; editing a file schedule creates a panel override. */
export function ScheduleDialog({
  entry,
  taken,
  onClose,
}: {
  entry?: ConfigEntryView<'schedule'>
  taken: readonly string[]
  onClose: () => void
}) {
  const isNew = entry === undefined
  const [draft, setDraft] = useState<ScheduleDraft>(() => toScheduleDraft(entry))
  const [submitted, setSubmitted] = useState(false)
  const [restored, setRestored] = useState(0)
  const [brokenOptions, setBrokenOptions] = useState<ReadonlySet<string>>(() => new Set())
  const { put } = useConfigMutations('schedules')
  const detail = useConfigEntry('schedules', entry?.version === undefined ? undefined : entry.id)
  const errors = submitted ? validateScheduleDraft(draft, isNew ? taken : []) : {}
  const set = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const setOptions = useCallback((kind: string, value: Record<string, unknown> | undefined) => {
    setBrokenOptions((previous) => {
      if (previous.has(kind) === (value === undefined)) return previous
      const next = new Set(previous)
      if (value === undefined) next.add(kind)
      else next.delete(kind)
      return next
    })
    if (value !== undefined) setDraft((d) => ({ ...d, options: { ...d.options, [kind]: value } }))
  }, [])
  const optionsBroken = draft.analyzers.some((kind) => brokenOptions.has(kind))

  const submit = () => {
    setSubmitted(true)
    if (Object.keys(validateScheduleDraft(draft, isNew ? taken : [])).length) return
    if (optionsBroken) return
    put.mutate(
      { id: draft.id.trim(), data: toScheduleInput(draft) },
      {
        onSuccess: () => {
          notify.success(isNew ? 'Schedule added' : 'Schedule saved', draft.name || draft.id)
          onClose()
        },
      },
    )
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={isNew ? 'Add schedule' : `Edit ${entry.data.name}`}
      description="Times are local to the schedule's zone. Windows limit when runs may happen; a run in a denied minute moves to the next allowed one."
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onPress={submit} isPending={put.isPending}>
            {isNew ? 'Add' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {put.error ? (
          <Notice tone="danger" title="Not saved">
            {messageOf(put.error)}
          </Notice>
        ) : null}
        {entry?.provenance === 'file' ? (
          <Notice title="Defined in the config file">
            Saving creates a panel version that replaces it; delete that version later to go back to
            the file.
          </Notice>
        ) : entry?.provenance === 'file+panel' ? (
          <Notice title="Overrides the config file">
            Reverting removes this panel version and brings back the file schedule.
          </Notice>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Id"
            value={draft.id}
            onChange={(v) => set('id', v)}
            error={errors.id}
            placeholder="nightly"
            mono
            isRequired
            isDisabled={!isNew}
            autoFocus={isNew}
            description="Lowercase letters, digits and dashes; cannot change later."
          />
          <TextField
            label="Display name"
            value={draft.name}
            onChange={(v) => set('name', v)}
            placeholder={draft.id || 'Nightly checks'}
          />
        </div>
        <Switch
          label="Enabled"
          isSelected={draft.enabled}
          onChange={(v) => set('enabled', v)}
          description="Disabled schedules stay in the config but never run."
        />

        <FormSection title="Cadence">
          <Segmented
            aria-label="Cadence"
            options={[
              { id: 'every', label: 'Interval' },
              { id: 'cron', label: 'Cron' },
            ]}
            value={draft.cadence}
            onChange={(v) => set('cadence', v)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {draft.cadence === 'every' ? (
              <TextField
                label="Every"
                value={draft.every}
                onChange={(v) => set('every', v)}
                error={errors.every}
                placeholder="1h"
                mono
                description={
                  draft.every
                    ? `${describeCadence({ every: draft.every })}, from the start of each allowed stretch.`
                    : '15m, 1h, 6h, 1d, …'
                }
              />
            ) : (
              <TextField
                label="Cron"
                value={draft.cron}
                onChange={(v) => set('cron', v)}
                error={errors.cron}
                placeholder="0 3 * * 1-5"
                mono
                description="Minute, hour, day of month, month, weekday; or @daily."
              />
            )}
            <TextField
              label="Time zone"
              value={draft.timezone}
              onChange={(v) => set('timezone', v)}
              error={errors.timezone}
              placeholder={browserZone}
              mono
              description="IANA zone; empty uses the server's zone."
            />
          </div>
        </FormSection>

        <FormSection title="What and where">
          <AnalyzerPicker
            label="Analyzers"
            value={draft.analyzers}
            onChange={(v) => set('analyzers', v)}
            error={errors.analyzers}
          />
          <GroupPicker value={draft.groups} onChange={(v) => set('groups', v)} />
          <div className="flex flex-col gap-1">
            <TagInput
              label="Only repositories"
              values={draft.repos}
              onChange={(v) => set('repos', v)}
              placeholder="work:games/*"
              validate={(v) => (/^[^:]+:.+$/.test(v) ? undefined : 'forge:path, globs allowed')}
              description="forge:path globs; empty runs on every repository of the groups."
            />
            {errors.repos ? <span className="text-xs text-danger">{errors.repos}</span> : null}
          </div>
        </FormSection>

        <AnalyzerOptions
          key={restored}
          kinds={draft.analyzers}
          options={draft.options}
          onChange={setOptions}
          error={submitted && optionsBroken ? 'Fix the analyzer options to save.' : undefined}
        />

        <FormSection
          title="Windows"
          description="Allow windows restrict runs to them; deny windows, nights, weekends and holidays always win."
        >
          <WindowList
            title="Allow"
            windows={draft.allow}
            onChange={(v) => set('allow', v)}
            error={errors.allow}
          />
          <WindowList
            title="Deny"
            windows={draft.deny}
            onChange={(v) => set('deny', v)}
            error={errors.deny}
          />
          <Switch
            label="Skip weekends"
            isSelected={draft.skipWeekends}
            onChange={(v) => set('skipWeekends', v)}
          />
          <div className="flex flex-col gap-2">
            <Switch
              label="Skip nights"
              isSelected={draft.skipNights}
              onChange={(v) => set('skipNights', v)}
            />
            {draft.skipNights ? (
              <div className="grid max-w-sm grid-cols-2 gap-3">
                <TextField
                  label="From"
                  value={draft.nightFrom}
                  onChange={(v) => set('nightFrom', v)}
                  placeholder="22:00"
                  mono
                />
                <TextField
                  label="To"
                  value={draft.nightTo}
                  onChange={(v) => set('nightTo', v)}
                  placeholder="07:00"
                  mono
                />
              </div>
            ) : null}
            {errors.nights ? <span className="text-xs text-danger">{errors.nights}</span> : null}
          </div>
          <TagInput
            label="Holidays"
            values={draft.holidays}
            onChange={(v) => set('holidays', v)}
            placeholder="2026-12-24"
            validate={(v) => (isIsoDate(v) ? undefined : 'YYYY-MM-DD')}
            description="Whole local days without runs."
          />
        </FormSection>

        <FormSection title="Load">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Jitter (minutes)"
              type="number"
              min={0}
              max={1440}
              value={draft.jitterMinutes}
              onChange={(v) => set('jitterMinutes', v)}
              error={errors.jitterMinutes}
              placeholder="0"
              description="A stable 0..n minute delay per run."
            />
          </div>
          <Switch
            label="Spread repository jobs"
            isSelected={draft.spread}
            onChange={(v) => set('spread', v)}
            description="Queues repository jobs evenly over the run's window instead of all at once."
          />
        </FormSection>

        {entry && entry.data.enabled ? (
          <FormSection title="Next runs" description="Of the saved version.">
            <NextRuns id={entry.id} count={5} />
          </FormSection>
        ) : null}

        <EntryHistory
          detail={detail.data}
          describe={(data) => [describeCadence(data), data.analyzers.join(', ')].join(' · ')}
          onRestore={(data, version) => {
            if (!entry) return
            setDraft(toScheduleDraft({ ...entry, data }))
            setBrokenOptions(new Set())
            setRestored((count) => count + 1)
            notify.info(`Version ${version} loaded`, 'Save to apply it.')
          }}
        />
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

function AnalyzerOptions({
  kinds,
  options,
  onChange,
  error,
}: {
  kinds: readonly string[]
  options: ScheduleDraft['options']
  onChange: (kind: string, value: Record<string, unknown> | undefined) => void
  error?: string | undefined
}) {
  const analyzers = useJobAnalyzers()
  const picked = kinds.flatMap((kind) => {
    const analyzer = analyzers.data?.analyzers.find((a) => a.kind === kind)
    return analyzer ? [analyzer] : []
  })
  if (!picked.length) return null
  return (
    <FormSection
      title="Analyzer options"
      description="Apply to every job this schedule queues; options that are not set keep the analyzer's defaults."
    >
      {picked.map((analyzer) => (
        <AnalyzerOptionsEditor
          key={analyzer.kind}
          analyzer={analyzer}
          initial={options?.[analyzer.kind] ?? {}}
          onChange={onChange}
        />
      ))}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </FormSection>
  )
}

function AnalyzerOptionsEditor({
  analyzer,
  initial,
  onChange,
}: {
  analyzer: JobAnalyzerView
  initial: Record<string, unknown>
  onChange: (kind: string, value: Record<string, unknown> | undefined) => void
}) {
  const { kind } = analyzer
  const change = useCallback(
    (value: unknown) => onChange(kind, isRecord(value) ? value : undefined),
    [kind, onChange],
  )
  return (
    <StructuredEditor
      schema={analyzer.schema}
      initial={initial}
      onChange={change}
      label={analyzer.label}
    />
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function WindowList({
  title,
  windows,
  onChange,
  error,
}: {
  title: string
  windows: WindowDraft[]
  onChange: (windows: WindowDraft[]) => void
  error?: string | undefined
}) {
  const update = (index: number, patch: Partial<WindowDraft>) =>
    onChange(windows.map((w, i) => (i === index ? { ...w, ...patch } : w)))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <Button variant="ghost" size="sm" onPress={() => onChange([...windows, newWindow()])}>
          <Plus className="size-3.5" />
          Add window
        </Button>
      </div>
      {windows.length === 0 ? (
        <span className="text-xs text-muted">None.</span>
      ) : (
        <ul className="flex flex-col gap-2">
          {windows.map((window, index) => (
            <li key={index} className="flex flex-wrap items-end gap-3 rounded-xl bg-default/60 p-3">
              <MultiToggle<Weekday>
                aria-label={`${title} window ${index + 1} days`}
                options={weekdays.map((day) => ({ id: day, label: dayLabel(day) }))}
                value={window.days}
                onChange={(days) => update(index, { days })}
              />
              <TextField
                aria-label="From"
                className="w-24"
                value={window.from}
                onChange={(from) => update(index, { from })}
                placeholder="09:00"
                mono
              />
              <span className="pb-2 text-muted">–</span>
              <TextField
                aria-label="To"
                className="w-24"
                value={window.to}
                onChange={(to) => update(index, { to })}
                placeholder="18:00"
                mono
              />
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={`Remove ${title.toLowerCase()} window ${index + 1}`}
                onPress={() => onChange(windows.filter((_, i) => i !== index))}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  )
}
