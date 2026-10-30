import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ACTION_HINTS,
  type ActionValue,
  CONDITION_FIELDS,
  CONDITION_FIELD_ORDER,
  type ConditionField,
  type ConditionValue,
  type GlobSetsValue,
  MERGE_REQUEST_EVENTS,
  PIPELINE_STATES,
  type PolicyValue,
  actionVariants,
  emptyField,
  isConditionField,
  newAction,
  newPolicy,
  normalizePolicies,
  policyProblems,
  serializePolicies,
  summarizePolicy,
} from '../../lib/policies.ts'
import { humanize } from '../../lib/schema-form.ts'
import { parseJson } from '../../lib/schema.ts'
import {
  Button,
  MultiToggle,
  Notice,
  Segmented,
  Select,
  Switch,
  TagInput,
  TextField,
  Tooltip,
} from '../../ui/index.ts'
import { Railed, RemoveButton } from './blocks.tsx'
import { SchemaForm } from './SchemaField.tsx'

let nextKey = 0
const freshKey = () => `k${++nextKey}`

interface Row {
  key: string
  policy: PolicyValue
}

/**
 * Edits merge request policies as blocks: each policy reads `If <conditions> → Then <actions>`,
 * with `Any of`, `All of` and `Not` groups for nested logic. Raw JSON is one toggle away. Reports
 * `undefined` while a policy has a problem the server would reject.
 */
export function PolicyEditor({
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
  const [rows, setRows] = useState<Row[]>(() =>
    normalizePolicies(initial).map((policy) => ({ key: freshKey(), policy })),
  )
  const [mode, setMode] = useState<'blocks' | 'json'>('blocks')
  const [text, setText] = useState('')
  const [jsonError, setJsonError] = useState<string>()
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(() => new Set())
  const variants = useMemo(() => actionVariants(schema), [schema])
  const policies = rows.map((row) => row.policy)
  const problems = policyProblems(policies)
  const broken = mode === 'json' ? jsonError !== undefined : problems.size > 0 || invalid.size > 0
  const serialized = useMemo(() => serializePolicies(rows.map((row) => row.policy)), [rows])

  useEffect(() => onChange(broken ? undefined : serialized), [onChange, broken, serialized])

  const reportInvalid = useCallback(
    (key: string, bad: boolean) =>
      setInvalid((previous) => {
        if (previous.has(key) === bad) return previous
        const next = new Set(previous)
        if (bad) next.add(key)
        else next.delete(key)
        return next
      }),
    [],
  )

  const update = (index: number, policy: PolicyValue) =>
    setRows((previous) => previous.map((row, i) => (i === index ? { ...row, policy } : row)))
  const move = (from: number, to: number) =>
    setRows((previous) => {
      const next = [...previous]
      const [moved] = next.splice(from, 1)
      if (moved) next.splice(to, 0, moved)
      return next
    })

  const switchTo = (next: 'blocks' | 'json') => {
    if (next === mode) return
    if (next === 'json') {
      setText(JSON.stringify(serialized, null, 2))
      setJsonError(undefined)
      setMode('json')
      return
    }
    const parsed = parseJson(text)
    if (!parsed.ok) return
    setRows(normalizePolicies(parsed.value).map((policy) => ({ key: freshKey(), policy })))
    setInvalid(new Set())
    setMode('blocks')
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <Segmented
          aria-label="Editor"
          value={mode}
          onChange={switchTo}
          options={[
            { id: 'blocks', label: 'Blocks' },
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
          error={jsonError}
          description="Fix any error to switch back to blocks."
          onChange={(next) => {
            setText(next)
            const result = parseJson(next)
            setJsonError(result.ok ? undefined : result.error)
          }}
        />
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-separator p-6 text-center text-sm text-muted">
              No policies yet. Add one and describe when it applies and what it does.
            </p>
          ) : null}
          {rows.map((row, index) => (
            <PolicyBlock
              key={row.key}
              rowKey={row.key}
              index={index}
              count={rows.length}
              policy={row.policy}
              problems={problems.get(index) ?? []}
              variants={variants}
              root={schema}
              onChange={(policy) => update(index, policy)}
              onMove={(to) => move(index, to)}
              onRemove={() => setRows((previous) => previous.filter((_, i) => i !== index))}
              onInvalid={reportInvalid}
            />
          ))}
          <div>
            <Button
              variant="secondary"
              size="sm"
              onPress={() =>
                setRows((previous) => [
                  ...previous,
                  { key: freshKey(), policy: newPolicy(previous.map((r) => r.policy.id)) },
                ])
              }
            >
              <Plus className="size-3.5" />
              Add policy
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function PolicyBlock({
  rowKey,
  index,
  count,
  policy,
  problems,
  variants,
  root,
  onChange,
  onMove,
  onRemove,
  onInvalid,
}: {
  rowKey: string
  index: number
  count: number
  policy: PolicyValue
  problems: string[]
  variants: Map<string, Record<string, unknown>>
  root: unknown
  onChange: (policy: PolicyValue) => void
  onMove: (to: number) => void
  onRemove: () => void
  onInvalid: (key: string, invalid: boolean) => void
}) {
  const actionKeys = useRef<string[]>([])
  while (actionKeys.current.length < policy.actions.length) actionKeys.current.push(freshKey())
  const set = (patch: Partial<PolicyValue>) => onChange({ ...policy, ...patch })
  const setActions = (actions: ActionValue[], keys: string[]) => {
    actionKeys.current = keys
    set({ actions })
  }
  const skip = policy.skipAnalyzers
  const skipMode = skip === '*' ? 'all' : skip ? 'some' : 'none'

  return (
    <section
      aria-label={`Policy ${policy.name || index + 1}`}
      className={`flex flex-col gap-4 rounded-2xl border border-separator bg-surface p-4 shadow-surface ${policy.enabled ? '' : 'opacity-70'}`}
    >
      <header className="flex flex-wrap items-start gap-3">
        <span className="mt-2 grid size-6 shrink-0 place-items-center rounded-full bg-default text-xs font-semibold">
          {index + 1}
        </span>
        <TextField
          label="Name"
          value={policy.name}
          className="min-w-48 flex-1"
          onChange={(name) => set({ name })}
        />
        <TextField
          label="Id"
          value={policy.id}
          mono
          className="w-48"
          description="Reuse an id to override a broader policy"
          onChange={(id) => set({ id })}
        />
        <div className="mt-7 flex items-center gap-1">
          <Switch label="On" isSelected={policy.enabled} onChange={(enabled) => set({ enabled })} />
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="Move policy up"
            isDisabled={index === 0}
            onPress={() => onMove(index - 1)}
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="Move policy down"
            isDisabled={index === count - 1}
            onPress={() => onMove(index + 1)}
          >
            <ArrowDown className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="Remove policy"
            onPress={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </header>

      <p className="rounded-xl bg-default/60 px-3 py-2 font-mono text-xs text-muted">
        {summarizePolicy(policy)}
      </p>
      {problems.length ? (
        <Notice tone="danger" title="Fix before saving">
          {problems.join('. ')}
        </Notice>
      ) : null}

      <Railed rail="when" hint="Every condition in this block must hold. Empty means always.">
        <ConditionBlock value={policy.when} onChange={(when) => set({ when })} joiner="and" />
      </Railed>

      <Railed rail="actions" hint="Actions run in order when the conditions hold.">
        <div className="flex flex-col gap-2">
          {policy.actions.map((action, i) => {
            const key = actionKeys.current[i] ?? String(i)
            return (
              <ActionBlock
                key={key}
                invalidKey={`${rowKey}/${key}`}
                action={action}
                variant={variants.get(action.type)}
                root={root}
                onChange={(next) =>
                  setActions(
                    policy.actions.map((a, j) => (j === i ? next : a)),
                    actionKeys.current,
                  )
                }
                onRemove={() => {
                  onInvalid(`${rowKey}/${key}`, false)
                  setActions(
                    policy.actions.filter((_, j) => j !== i),
                    actionKeys.current.filter((_, j) => j !== i),
                  )
                }}
                onInvalid={onInvalid}
              />
            )
          })}
          <Select
            aria-label="Add action"
            placeholder="Add action…"
            className="w-60"
            value={undefined}
            options={[...variants.keys()].map((type) => ({ id: type, label: humanize(type) }))}
            onChange={(type) =>
              setActions(
                [...policy.actions, newAction(type, variants.get(type), root)],
                [...actionKeys.current, freshKey()],
              )
            }
          />
          <div className="mt-2 flex flex-wrap items-start gap-x-6 gap-y-3 border-t border-separator pt-3">
            <Switch
              label="Stop here"
              description="Skip later policies once this one matched"
              isSelected={policy.stop === true}
              onChange={(stop) => {
                const { stop: _, ...rest } = policy
                onChange(stop ? { ...rest, stop: true } : rest)
              }}
            />
            <div className="flex min-w-64 flex-1 flex-col gap-2">
              <span className="text-sm font-medium">Skip analyzers</span>
              <Segmented
                aria-label="Skip analyzers"
                value={skipMode}
                onChange={(next) => {
                  const { skipAnalyzers: _, ...rest } = policy
                  onChange(
                    next === 'none'
                      ? rest
                      : {
                          ...rest,
                          skipAnalyzers: next === 'all' ? '*' : Array.isArray(skip) ? skip : [],
                        },
                  )
                }}
                options={[
                  { id: 'none', label: 'None' },
                  { id: 'some', label: 'Listed' },
                  { id: 'all', label: 'All' },
                ]}
              />
              {Array.isArray(skip) ? (
                <TagInput
                  label="Analyzers to skip"
                  hideLabel
                  placeholder="Analyzer kind, then Enter"
                  values={skip}
                  onChange={(skipAnalyzers) => set({ skipAnalyzers })}
                />
              ) : null}
            </div>
          </div>
        </div>
      </Railed>
    </section>
  )
}

function Joiner({ word }: { word: 'and' | 'or' }) {
  return (
    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
      <span className="h-px w-4 bg-separator" />
      {word}
      <span className="h-px flex-1 bg-separator" />
    </div>
  )
}

const GROUP_OPTIONS = [
  { id: 'group:any', label: 'Any of… (or)' },
  { id: 'group:all', label: 'All of… (and group)' },
  { id: 'group:not', label: 'Not…' },
]

/** A condition: its set fields and nested groups, all of which must hold. */
function ConditionBlock({
  value,
  onChange,
  joiner,
}: {
  value: ConditionValue
  onChange: (value: ConditionValue) => void
  joiner: 'and'
}) {
  const fields = CONDITION_FIELD_ORDER.filter((field) => value[field] !== undefined)
  const unset = CONDITION_FIELD_ORDER.filter((field) => value[field] === undefined)
  const without = <K extends keyof ConditionValue>(key: K) => {
    const { [key]: _, ...rest } = value
    return rest
  }
  const items: ReactNode[] = [
    ...fields.map((field) => (
      <LeafRow
        key={field}
        field={field}
        value={value}
        onChange={onChange}
        onRemove={() => onChange(without(field))}
      />
    )),
    ...(value.all ?? []).map((nested, i) => (
      <Railed
        key={`all-${i}`}
        rail="all"
        hint="Every condition inside must hold"
        actions={
          <RemoveButton
            label="Remove group"
            onPress={() => {
              const all = (value.all ?? []).filter((_, j) => j !== i)
              onChange(all.length ? { ...value, all } : without('all'))
            }}
          />
        }
      >
        <ConditionBlock
          value={nested}
          joiner="and"
          onChange={(next) =>
            onChange({ ...value, all: (value.all ?? []).map((c, j) => (j === i ? next : c)) })
          }
        />
      </Railed>
    )),
    ...(value.any
      ? [
          <AnyGroup
            key="any"
            options={value.any}
            onChange={(any) => onChange(any.length ? { ...value, any } : without('any'))}
          />,
        ]
      : []),
    ...(value.not
      ? [
          <Railed
            key="not"
            rail="not"
            hint="Holds when the conditions inside do not"
            actions={
              <RemoveButton label="Remove Not group" onPress={() => onChange(without('not'))} />
            }
          >
            <ConditionBlock
              value={value.not}
              joiner="and"
              onChange={(not) => onChange({ ...value, not })}
            />
          </Railed>,
        ]
      : []),
  ]

  const add = (id: string) => {
    if (id === 'group:any') onChange({ ...value, any: [...(value.any ?? []), {}, {}] })
    else if (id === 'group:all') onChange({ ...value, all: [...(value.all ?? []), {}] })
    else if (id === 'group:not') onChange({ ...value, not: value.not ?? {} })
    else if (isConditionField(id)) onChange({ ...value, [id]: emptyField(id) })
  }

  return (
    <div className="flex flex-col gap-2">
      {items.length === 0 ? <p className="text-sm text-muted">Always applies.</p> : null}
      {items.flatMap((item, i) =>
        i === 0 ? [item] : [<Joiner key={`j-${i}`} word={joiner} />, item],
      )}
      <Select
        aria-label="Add condition"
        placeholder="Add condition…"
        className="w-60"
        value={undefined}
        options={[
          ...unset.map((field) => ({ id: field, label: CONDITION_FIELDS[field].label })),
          ...GROUP_OPTIONS.filter((option) => option.id !== 'group:not' || !value.not).filter(
            (option) => option.id !== 'group:any' || !value.any,
          ),
        ]}
        onChange={add}
      />
    </div>
  )
}

function AnyGroup({
  options,
  onChange,
}: {
  options: ConditionValue[]
  onChange: (options: ConditionValue[]) => void
}) {
  return (
    <Railed
      rail="any"
      hint="At least one alternative must hold"
      actions={<RemoveButton label="Remove Any of group" onPress={() => onChange([])} />}
    >
      {options.flatMap((option, i) => {
        const block = (
          <div
            key={`o-${i}`}
            className="flex items-start gap-2 rounded-xl border border-separator p-3"
          >
            <div className="min-w-0 flex-1">
              <ConditionBlock
                value={option}
                joiner="and"
                onChange={(next) => onChange(options.map((o, j) => (j === i ? next : o)))}
              />
            </div>
            <RemoveButton
              label={`Remove alternative ${i + 1}`}
              onPress={() => onChange(options.filter((_, j) => j !== i))}
            />
          </div>
        )
        return i === 0 ? [block] : [<Joiner key={`j-${i}`} word="or" />, block]
      })}
      <div>
        <Button variant="secondary" size="sm" onPress={() => onChange([...options, {}])}>
          <Plus className="size-3.5" />
          Add alternative
        </Button>
      </div>
    </Railed>
  )
}

function LeafRow({
  field,
  value,
  onChange,
  onRemove,
}: {
  field: ConditionField
  value: ConditionValue
  onChange: (value: ConditionValue) => void
  onRemove: () => void
}) {
  const meta = CONDITION_FIELDS[field]
  return (
    <div className="grid items-start gap-2 rounded-xl bg-default/50 p-2.5 sm:grid-cols-[9rem_minmax(0,1fr)_auto]">
      <Tooltip content={meta.hint}>
        <span className="pt-2 text-sm font-medium">{meta.label}</span>
      </Tooltip>
      <div className="min-w-0">
        <LeafEditor field={field} value={value} onChange={onChange} />
      </div>
      <RemoveButton label={`Remove ${meta.label} condition`} onPress={onRemove} />
    </div>
  )
}

function LeafEditor({
  field,
  value,
  onChange,
}: {
  field: ConditionField
  value: ConditionValue
  onChange: (value: ConditionValue) => void
}) {
  const label = CONDITION_FIELDS[field].label
  switch (field) {
    case 'event':
    case 'pipeline': {
      const options = field === 'event' ? MERGE_REQUEST_EVENTS : PIPELINE_STATES
      return (
        <MultiToggle
          aria-label={label}
          options={options.map((id) => ({ id, label: id }))}
          value={value[field] ?? []}
          onChange={(next) => onChange({ ...value, [field]: next })}
        />
      )
    }
    case 'targetBranch':
    case 'sourceBranch':
    case 'labelAdded':
    case 'command':
      return (
        <TagInput
          label={label}
          hideLabel
          placeholder={field === 'command' ? 'approve, then Enter' : 'Type, then Enter'}
          values={value[field] ?? []}
          onChange={(next) => onChange({ ...value, [field]: next })}
        />
      )
    case 'title':
      return (
        <TextField
          aria-label={label}
          mono
          placeholder="^(chore|deps)\b"
          value={value.title ?? ''}
          onChange={(title) => onChange({ ...value, title })}
        />
      )
    case 'draft':
      return (
        <Segmented
          aria-label={label}
          value={value.draft ? 'draft' : 'ready'}
          onChange={(next) => onChange({ ...value, draft: next === 'draft' })}
          options={[
            { id: 'ready', label: 'Not a draft' },
            { id: 'draft', label: 'Is a draft' },
          ]}
        />
      )
    case 'author': {
      const author = value.author ?? {}
      return (
        <div className="flex flex-col gap-2">
          <TagInput
            label="Users"
            hideLabel
            placeholder="Username or glob, then Enter (empty: anyone)"
            values={author.users ?? []}
            onChange={(users) => onChange({ ...value, author: { ...author, users } })}
          />
          <Segmented
            aria-label="Bot or person"
            value={author.bot === undefined ? 'any' : author.bot ? 'bot' : 'person'}
            onChange={(next) => {
              const { bot: _, ...rest } = author
              onChange({
                ...value,
                author: next === 'any' ? rest : { ...rest, bot: next === 'bot' },
              })
            }}
            options={[
              { id: 'any', label: 'Anyone' },
              { id: 'bot', label: 'Bots' },
              { id: 'person', label: 'People' },
            ]}
          />
        </div>
      )
    }
    case 'labels':
    case 'changedPaths':
      return (
        <GlobSetsEditor
          noun={field === 'labels' ? 'labels' : 'paths'}
          value={value[field] ?? {}}
          onChange={(next) => onChange({ ...value, [field]: next })}
        />
      )
    default:
      return (
        <SizeEditor value={value.size ?? {}} onChange={(size) => onChange({ ...value, size })} />
      )
  }
}

function GlobSetsEditor({
  noun,
  value,
  onChange,
}: {
  noun: string
  value: GlobSetsValue
  onChange: (value: GlobSetsValue) => void
}) {
  const parts = [
    { key: 'any', label: `Has any of these ${noun}` },
    { key: 'all', label: `All ${noun} match` },
    { key: 'none', label: `None of the ${noun} match` },
  ] as const
  return (
    <div className="grid gap-2 md:grid-cols-3">
      {parts.map((part) => (
        <TagInput
          key={part.key}
          label={<span className="text-xs text-muted">{part.label}</span>}
          values={value[part.key] ?? []}
          placeholder="Type, then Enter"
          onChange={(next) => onChange({ ...value, [part.key]: next })}
        />
      ))}
    </div>
  )
}

function SizeEditor({
  value,
  onChange,
}: {
  value: NonNullable<ConditionValue['size']>
  onChange: (value: NonNullable<ConditionValue['size']>) => void
}) {
  const fields = [
    { key: 'maxLines', label: 'At most lines' },
    { key: 'maxFiles', label: 'At most files' },
    { key: 'minLines', label: 'At least lines' },
    { key: 'minFiles', label: 'At least files' },
  ] as const
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {fields.map((field) => (
        <TextField
          key={field.key}
          label={<span className="text-xs text-muted">{field.label}</span>}
          type="number"
          min={0}
          value={value[field.key] === undefined ? '' : String(value[field.key])}
          onChange={(text) => {
            const { [field.key]: _, ...rest } = value
            const n = Number(text)
            onChange(
              text.trim() === '' || !Number.isInteger(n) || n < 0
                ? rest
                : { ...rest, [field.key]: n },
            )
          }}
        />
      ))}
    </div>
  )
}

function ActionBlock({
  invalidKey,
  action,
  variant,
  root,
  onChange,
  onRemove,
  onInvalid,
}: {
  invalidKey: string
  action: ActionValue
  variant: Record<string, unknown> | undefined
  root: unknown
  onChange: (action: ActionValue) => void
  onRemove: () => void
  onInvalid: (key: string, invalid: boolean) => void
}) {
  const reportInvalid = useCallback(
    (bad: boolean) => onInvalid(invalidKey, bad),
    [onInvalid, invalidKey],
  )
  useEffect(() => () => onInvalid(invalidKey, false), [onInvalid, invalidKey])
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-separator p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{humanize(action.type)}</span>
        <span className="text-xs text-muted">{ACTION_HINTS[action.type] ?? ''}</span>
        <span className="ml-auto">
          <RemoveButton label={`Remove ${action.type} action`} onPress={onRemove} />
        </span>
      </div>
      {variant ? (
        <SchemaForm
          schema={variant}
          root={root}
          value={action}
          label={humanize(action.type)}
          onInvalid={reportInvalid}
          onChange={(next) =>
            onChange({
              ...(typeof next === 'object' && next !== null ? next : {}),
              type: action.type,
            })
          }
        />
      ) : (
        <p className="text-xs text-muted">Options of this action can be edited in JSON.</p>
      )}
    </div>
  )
}
