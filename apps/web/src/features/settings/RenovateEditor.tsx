import { GitPullRequest, Gauge, Package, SlidersHorizontal } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'

import {
  type RenovateField,
  type RenovateValue,
  normalizeRenovateValue,
  presetSuggestions,
  reader,
  renovateFields,
  renovateSummary,
} from '../../lib/renovate.ts'
import { parseJson } from '../../lib/schema.ts'
import {
  Button,
  Chip,
  Notice,
  Segmented,
  Select,
  Switch,
  TagInput,
  TextField,
} from '../../ui/index.ts'

const modes = [
  { id: 'report', label: 'Report only' },
  { id: 'merge-requests', label: 'Open merge requests' },
] as const

const scopes = [
  { id: 'all', label: 'Every update' },
  { id: 'security', label: 'Security fixes only' },
] as const

const groupings = [
  { id: 'separate', label: 'One per dependency' },
  { id: 'non-major', label: 'Minor & patch together' },
  { id: 'all', label: 'Everything together' },
] as const

const repoConfigs = [
  { id: 'merge', label: 'Apply renovate.json' },
  { id: 'ignore', label: 'Ignore it' },
] as const

const rangeStrategies = [
  { id: 'auto', label: 'Auto: Renovate decides' },
  { id: 'bump', label: 'Bump: raise the range to the new version' },
  { id: 'replace', label: 'Replace: only when the new version is out of range' },
  { id: 'widen', label: 'Widen: extend the range to include it' },
  { id: 'pin', label: 'Pin: exact versions' },
  { id: 'update-lockfile', label: 'Lockfile only: keep ranges as they are' },
]

/**
 * Edits `analyzers.renovate` as four plain-language sections with a live summary of what Renovate
 * will do. Unset options show their default and keep it; set ones can be reset. Raw JSON is one
 * toggle away. Reports `undefined` while the raw config or the JSON is not valid.
 */
export function RenovateEditor({
  schema,
  initial,
  onChange,
  label,
}: {
  schema: unknown
  initial: unknown
  onChange: (value: unknown) => void
  label: string
}) {
  const fields = useMemo(() => renovateFields(schema), [schema])
  const [value, setValue] = useState<RenovateValue>(() => normalizeRenovateValue(initial))
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [text, setText] = useState('')
  const [configText, setConfigText] = useState(() =>
    value.config === undefined ? '' : JSON.stringify(value.config, null, 2),
  )
  const parsedJson = mode === 'json' ? parseJson(text) : undefined
  const parsedConfig = configText.trim() ? parseJson(configText) : undefined
  const configError =
    parsedConfig &&
    (!parsedConfig.ok ||
      typeof parsedConfig.value !== 'object' ||
      Array.isArray(parsedConfig.value))
      ? parsedConfig.ok
        ? 'Expected a JSON object'
        : parsedConfig.error
      : undefined

  const result =
    mode === 'json'
      ? parsedJson?.ok
        ? parsedJson.value
        : undefined
      : configError
        ? undefined
        : value
  const resultKey = result === undefined ? '' : JSON.stringify(result)
  useEffect(() => onChange(resultKey ? JSON.parse(resultKey) : undefined), [onChange, resultKey])

  const set = (key: string, next: unknown) => setValue((previous) => ({ ...previous, [key]: next }))
  const reset = (key: string) =>
    setValue((previous) => {
      const { [key]: _removed, ...rest } = previous
      return rest
    })
  const get = reader(value, fields)
  const field = (key: string) => ({
    meta: fields[key] ?? { title: key, default: undefined },
    isSet: value[key] !== undefined,
    onReset: () => reset(key),
  })

  const switchTo = (next: 'form' | 'json') => {
    if (next === mode) return
    if (next === 'json') {
      setText(JSON.stringify(value, null, 2))
      setMode('json')
      return
    }
    const parsed = parseJson(text)
    if (!parsed.ok) return
    const normalized = normalizeRenovateValue(parsed.value)
    setValue(normalized)
    setConfigText(normalized.config === undefined ? '' : JSON.stringify(normalized.config, null, 2))
    setMode('form')
  }

  const opensMergeRequests = get.text('mode', 'report') === 'merge-requests'
  const security = get.text('updates', 'all') === 'security'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <Segmented
          aria-label="Editor"
          value={mode}
          onChange={switchTo}
          options={[
            { id: 'form', label: 'Form' },
            { id: 'json', label: 'JSON' },
          ]}
        />
      </div>

      {mode === 'json' ? (
        <TextField
          aria-label={label}
          multiline
          rows={18}
          mono
          value={text}
          onChange={setText}
          {...(parsedJson && !parsedJson.ok ? { error: parsedJson.error } : {})}
        />
      ) : (
        <>
          <Notice tone={opensMergeRequests ? 'accent' : 'default'} title="What Renovate will do">
            {renovateSummary(value, fields)}
          </Notice>

          <Section
            icon={<Gauge />}
            title="Mode"
            hint="Start with a report, open merge requests once it looks right"
          >
            <Field {...field('mode')}>
              <Segmented
                aria-label="Mode"
                size="md"
                options={modes}
                value={get.text('mode', 'report')}
                onChange={(next) => set('mode', next)}
              />
            </Field>
            <Field {...field('updates')}>
              <Segmented
                aria-label="Updates"
                options={scopes}
                value={get.text('updates', 'all')}
                onChange={(next) => set('updates', next)}
              />
            </Field>
          </Section>

          <Section
            icon={<Package />}
            title="Which updates"
            hint="What counts as an update and when it is proposed"
          >
            <div className={`grid gap-4 sm:grid-cols-2 ${security ? 'opacity-60' : ''}`}>
              <Field {...field('releaseAgeDays')}>
                <NumberField
                  label="Days"
                  value={get.number('releaseAgeDays', 3)}
                  min={0}
                  max={90}
                  onChange={(next) => set('releaseAgeDays', next)}
                />
              </Field>
              <Field {...field('rangeStrategy')}>
                <Select
                  aria-label="Range strategy"
                  options={rangeStrategies}
                  value={get.text('rangeStrategy', 'auto')}
                  onChange={(next) => set('rangeStrategy', next)}
                />
              </Field>
            </div>
            <Field {...field('grouping')}>
              <Segmented
                aria-label="Grouping"
                options={groupings}
                value={get.text('grouping', 'separate')}
                onChange={(next) => set('grouping', next)}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <ToggleField
                {...field('majors')}
                isSelected={get.flag('majors', true)}
                onChange={(next) => set('majors', next)}
              />
              <ToggleField
                {...field('vulnerabilityAlerts')}
                isSelected={security || get.flag('vulnerabilityAlerts', true)}
                isDisabled={security}
                onChange={(next) => set('vulnerabilityAlerts', next)}
              />
              <ToggleField
                {...field('lockFileMaintenance')}
                isSelected={get.flag('lockFileMaintenance', false)}
                onChange={(next) => set('lockFileMaintenance', next)}
              />
            </div>
            <Field {...field('ignore')}>
              <TagInput
                label="Ignored dependencies"
                hideLabel
                placeholder="react, @internal/*"
                values={get.list('ignore', [])}
                onChange={(next) => set('ignore', next)}
              />
            </Field>
          </Section>

          <Section
            icon={<GitPullRequest />}
            title="Merge requests"
            hint={
              opensMergeRequests
                ? 'How Renovate proposes updates'
                : 'Applies once Renovate opens merge requests'
            }
            muted={!opensMergeRequests}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field {...field('concurrentLimit')}>
                <NumberField
                  label="Open at once"
                  value={get.number('concurrentLimit', 10)}
                  min={0}
                  onChange={(next) => set('concurrentLimit', next)}
                />
              </Field>
              <Field {...field('hourlyLimit')}>
                <NumberField
                  label="New per hour"
                  value={get.number('hourlyLimit', 2)}
                  min={0}
                  onChange={(next) => set('hourlyLimit', next)}
                />
              </Field>
              <Field {...field('labels')}>
                <TagInput
                  label="Labels"
                  hideLabel
                  values={get.list('labels', [])}
                  onChange={(next) => set('labels', next)}
                />
              </Field>
              <Field {...field('branchPrefix')}>
                <TextField
                  aria-label="Branch prefix"
                  mono
                  value={get.text('branchPrefix', 'renovate/')}
                  onChange={(next) =>
                    next.trim() ? set('branchPrefix', next) : reset('branchPrefix')
                  }
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ToggleField
                {...field('draft')}
                isSelected={get.flag('draft', false)}
                onChange={(next) => set('draft', next)}
              />
              <ToggleField
                {...field('dependencyDashboard')}
                isSelected={get.flag('dependencyDashboard', false)}
                onChange={(next) => set('dependencyDashboard', next)}
              />
            </div>
          </Section>

          <Section
            icon={<SlidersHorizontal />}
            title="Advanced"
            hint="Renovate presets and options the fields above do not cover"
          >
            <Field {...field('repoConfig')}>
              <Segmented
                aria-label="Repository config"
                options={repoConfigs}
                value={get.text('repoConfig', 'merge')}
                onChange={(next) => set('repoConfig', next)}
              />
            </Field>
            <Field {...field('presets')}>
              <TagInput
                label="Renovate presets"
                hideLabel
                suggestions={presetSuggestions}
                values={get.list('presets', ['config:recommended'])}
                onChange={(next) => set('presets', next)}
              />
            </Field>
            <Field
              {...field('config')}
              onReset={() => {
                reset('config')
                setConfigText('')
              }}
            >
              <TextField
                aria-label="Raw Renovate config"
                multiline
                rows={6}
                mono
                placeholder={
                  '{\n  "packageRules": [{ "matchPackageNames": ["react"], "automerge": true }]\n}'
                }
                value={configText}
                onChange={(next) => {
                  setConfigText(next)
                  const parsed = next.trim() ? parseJson(next) : undefined
                  if (!parsed) reset('config')
                  else if (
                    parsed.ok &&
                    typeof parsed.value === 'object' &&
                    parsed.value &&
                    !Array.isArray(parsed.value)
                  )
                    set('config', parsed.value)
                }}
                {...(configError ? { error: configError } : {})}
              />
            </Field>
            <Field {...field('timeoutMinutes')}>
              <NumberField
                label="Minutes"
                value={get.number('timeoutMinutes', 30)}
                min={1}
                onChange={(next) => set('timeoutMinutes', next)}
              />
            </Field>
          </Section>
        </>
      )}
    </div>
  )
}

function Section({
  icon,
  title,
  hint,
  muted,
  children,
}: {
  icon: ReactNode
  title: string
  hint: string
  muted?: boolean
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
      <header className="flex items-start gap-3">
        <span className="mt-0.5 text-accent [&_svg]:size-4">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted">{hint}</p>
        </div>
      </header>
      <div className={`flex flex-col gap-4 ${muted ? 'opacity-70' : ''}`}>{children}</div>
    </section>
  )
}

function FieldState({ isSet, onReset }: { isSet: boolean; onReset: () => void }) {
  return isSet ? (
    <Button variant="ghost" size="sm" onPress={onReset}>
      Reset
    </Button>
  ) : (
    <Chip>default</Chip>
  )
}

function Field({
  meta,
  isSet,
  onReset,
  children,
}: {
  meta: RenovateField
  isSet: boolean
  onReset: () => void
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{meta.title}</span>
        <FieldState isSet={isSet} onReset={onReset} />
      </div>
      {children}
      {meta.description ? <p className="text-xs text-muted">{meta.description}</p> : null}
    </div>
  )
}

function ToggleField({
  meta,
  isSet,
  onReset,
  isSelected,
  isDisabled,
  onChange,
}: {
  meta: RenovateField
  isSet: boolean
  onReset: () => void
  isSelected: boolean
  isDisabled?: boolean
  onChange: (selected: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <Switch
          label={meta.title}
          isSelected={isSelected}
          onChange={onChange}
          isDisabled={isDisabled === true}
        />
        <FieldState isSet={isSet} onReset={onReset} />
      </div>
      {meta.description ? <p className="text-xs text-muted">{meta.description}</p> : null}
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [error, setError] = useState<string>()
  useEffect(() => setText(String(value)), [value])
  return (
    <TextField
      aria-label={label}
      type="number"
      value={text}
      {...(min !== undefined && { min })}
      {...(max !== undefined && { max })}
      onChange={(next) => {
        setText(next)
        const parsed = Number(next)
        const valid =
          next.trim() !== '' &&
          Number.isInteger(parsed) &&
          (min === undefined || parsed >= min) &&
          (max === undefined || parsed <= max)
        setError(
          valid
            ? undefined
            : `Enter a whole number${min !== undefined ? ` from ${min}` : ''}${max !== undefined ? ` to ${max}` : ''}`,
        )
        if (valid) onChange(parsed)
      }}
      {...(error ? { error } : {})}
    />
  )
}
