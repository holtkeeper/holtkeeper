import type { SettingView } from '@holtkeeper/api'
import { Plus, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useDescribeScope, useSettingMutations } from '../../api/queries.ts'
import { POLICIES_KEY } from '../../lib/automation-flow.ts'
import {
  ACTION_HINTS,
  type ActionValue,
  type ConditionValue,
  MERGE_REQUEST_EVENTS,
  type PolicyValue,
  actionVariants,
  describeCondition,
  newAction,
  newPolicy,
  normalizePolicies,
  policyProblems,
  withPolicy,
  withoutPolicy,
} from '../../lib/policies.ts'
import { humanize } from '../../lib/schema-form.ts'
import {
  Button,
  ConfirmDialog,
  MultiToggle,
  Notice,
  Segmented,
  Select,
  Switch,
  TagInput,
  TextField,
  notify,
} from '../../ui/index.ts'
import { SchemaForm } from '../settings/SchemaField.tsx'
import { RuleForm } from './RuleForm.tsx'
import { AnalyzerPicker } from './shared.tsx'

type Tri = 'any' | 'yes' | 'no'

const lists = (value: string[]) => (value.length ? value : undefined)

const triOf = (value: boolean | undefined): Tri =>
  value === undefined ? 'any' : value ? 'yes' : 'no'
const fromTri = (value: Tri): boolean | undefined => (value === 'any' ? undefined : value === 'yes')

/** Condition fields the drawer edits; anything else in `when` is kept as stored. */
const edited = [
  'event',
  'targetBranch',
  'sourceBranch',
  'author',
  'labelAdded',
  'command',
  'draft',
  'title',
] as const

function keptConditions(when: ConditionValue): string[] {
  const rest: ConditionValue = { ...when }
  for (const key of edited) delete rest[key]
  return describeCondition(rest)
}

function ActionBlock({
  action,
  variant,
  root,
  onChange,
  onRemove,
  onInvalid,
}: {
  action: ActionValue
  variant: Record<string, unknown> | undefined
  root: unknown
  onChange: (action: ActionValue) => void
  onRemove: () => void
  onInvalid: (invalid: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{humanize(action.type)}</span>
        <span className="truncate text-xs text-muted">{ACTION_HINTS[action.type] ?? ''}</span>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          className="ml-auto"
          aria-label={`Remove ${action.type}`}
          onPress={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {variant ? (
        <SchemaForm
          schema={variant}
          root={root}
          value={action}
          label={humanize(action.type)}
          onInvalid={onInvalid}
          onChange={(next) =>
            onChange({
              ...(typeof next === 'object' && next !== null ? next : {}),
              type: action.type,
            })
          }
        />
      ) : null}
    </div>
  )
}

/**
 * Edits one merge request policy of a `mergeRequests.policies` entry in the rule drawer, or adds
 * one: to `entry` when given, else to a new entry scoped to `group` (every repository without it).
 * The other policies of the entry are kept, in order.
 */
export function PolicyForm({
  entry,
  policyId,
  group,
  taken = [],
  schema,
  writable,
  onDone,
}: {
  entry?: SettingView
  policyId?: string
  group?: string
  /** Policy ids in use anywhere, so a new policy's default id cannot shadow or be shadowed. */
  taken?: readonly string[]
  /** The setting's form schema, for action options. */
  schema: unknown
  writable: boolean
  onDone: () => void
}) {
  const describeScope = useDescribeScope()
  const stored = useMemo(() => normalizePolicies(entry?.value), [entry])
  const original = stored.find((policy) => policy.id === policyId)
  const [initial] = useState<PolicyValue>(
    () => original ?? newPolicy([...taken, ...stored.map((p) => p.id)]),
  )
  const [policy, setPolicy] = useState<PolicyValue>(initial)
  const [invalid, setInvalid] = useState<ReadonlySet<number>>(() => new Set())
  const [removing, setRemoving] = useState(false)
  const { put, remove } = useSettingMutations()
  const variants = useMemo(() => actionVariants(schema), [schema])
  const next = withPolicy(entry?.value, policy, original?.id ?? policy.id)
  const problems = [...policyProblems(next).values()].flat()
  const when = policy.when
  const setWhen = (patch: Partial<ConditionValue>) => {
    const merged: ConditionValue = { ...when, ...patch }
    for (const key of edited) if (key in patch && patch[key] === undefined) delete merged[key]
    setPolicy({ ...policy, when: merged })
  }
  const reportInvalid = useCallback(
    (index: number) => (bad: boolean) =>
      setInvalid((previous) => {
        if (previous.has(index) === bad) return previous
        const copy = new Set(previous)
        if (bad) copy.add(index)
        else copy.delete(index)
        return copy
      }),
    [],
  )
  const kept = keptConditions(when)
  const scope = entry?.scope ?? (group === undefined ? { all: true } : { groups: [group] })

  const store = (value: PolicyValue[], message: string) => {
    const done = {
      onSuccess: () => {
        notify.success(message, policy.name)
        onDone()
      },
    }
    if (!value.length && entry) remove.mutate(entry.id, done)
    else put.mutate({ ...(entry ? { id: entry.id } : {}), key: POLICIES_KEY, scope, value }, done)
  }

  return (
    <>
      <RuleForm
        writable={writable}
        isPending={put.isPending || remove.isPending}
        dirty={JSON.stringify(policy) !== JSON.stringify(initial)}
        onDiscard={() => setPolicy(initial)}
        onSave={() => {
          if (problems.length || invalid.size) return
          store(next, original ? 'Policy saved' : 'Policy added')
        }}
        {...(original ? { onRemove: () => setRemoving(true) } : {})}
        notice={
          put.error ? (
            <Notice tone="danger" title="Not saved">
              {messageOf(put.error)}
            </Notice>
          ) : problems.length ? (
            <Notice tone="warning" title="Fix before saving">
              {problems.join('; ')}
            </Notice>
          ) : null
        }
        when={
          <>
            <div className="grid grid-cols-2 gap-2">
              <TextField
                label="Name"
                value={policy.name}
                onChange={(name) => setPolicy({ ...policy, name })}
              />
              <TextField
                label="Id"
                value={policy.id}
                onChange={(id) => setPolicy({ ...policy, id })}
                mono
                description="A narrower scope overrides a policy by reusing its id."
              />
            </div>
            <MultiToggle
              aria-label="Merge request events"
              options={MERGE_REQUEST_EVENTS.map((id) => ({ id, label: humanize(id) }))}
              value={(when.event ?? []).filter((e): e is (typeof MERGE_REQUEST_EVENTS)[number] =>
                (MERGE_REQUEST_EVENTS as readonly string[]).includes(e),
              )}
              onChange={(event) => setWhen({ event: lists(event) })}
            />
            <span className="text-xs text-muted">None selected: every merge request event.</span>
          </>
        }
        where={
          <p className="text-sm">
            {describeScope(scope)}
            <span className="block text-xs text-muted">
              Policies of every scope covering a repository apply, the narrowest first.
            </span>
          </p>
        }
        condition={
          <>
            <div className="grid grid-cols-2 gap-2">
              <TagInput
                label="Target branch"
                values={when.targetBranch ?? []}
                onChange={(v) => setWhen({ targetBranch: lists(v) })}
                placeholder="main"
              />
              <TagInput
                label="Source branch"
                values={when.sourceBranch ?? []}
                onChange={(v) => setWhen({ sourceBranch: lists(v) })}
                placeholder="bump/*"
              />
              <TagInput
                label="Label added"
                values={when.labelAdded ?? []}
                onChange={(v) => setWhen({ labelAdded: lists(v) })}
                placeholder="needs-check"
              />
              <TagInput
                label="Command"
                values={when.command ?? []}
                onChange={(v) => setWhen({ command: lists(v) })}
                placeholder="check"
              />
              <TagInput
                label="Author"
                values={when.author?.users ?? []}
                onChange={(users) => {
                  const author = {
                    ...(users.length ? { users } : {}),
                    ...(when.author?.bot !== undefined ? { bot: when.author.bot } : {}),
                  }
                  setWhen({ author: Object.keys(author).length ? author : undefined })
                }}
                placeholder="renovate-bot"
              />
              <TextField
                label="Title matches"
                value={when.title ?? ''}
                onChange={(title) => setWhen({ title: title || undefined })}
                mono
                placeholder="/^chore/i"
              />
            </div>
            <div className="flex flex-wrap gap-6">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted">Author is a bot</span>
                <Segmented
                  aria-label="Author is a bot"
                  options={[
                    { id: 'any', label: 'Any' },
                    { id: 'yes', label: 'Bot' },
                    { id: 'no', label: 'Person' },
                  ]}
                  value={triOf(when.author?.bot)}
                  onChange={(value: Tri) => {
                    const bot = fromTri(value)
                    const author = {
                      ...(when.author?.users?.length ? { users: when.author.users } : {}),
                      ...(bot !== undefined ? { bot } : {}),
                    }
                    setWhen({ author: Object.keys(author).length ? author : undefined })
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted">Draft</span>
                <Segmented
                  aria-label="Draft"
                  options={[
                    { id: 'any', label: 'Any' },
                    { id: 'yes', label: 'Draft' },
                    { id: 'no', label: 'Ready' },
                  ]}
                  value={triOf(when.draft)}
                  onChange={(value: Tri) => setWhen({ draft: fromTri(value) })}
                />
              </div>
            </div>
            {kept.length ? (
              <p className="text-xs text-muted">Also, kept as stored: {kept.join('; ')}.</p>
            ) : null}
          </>
        }
        then={
          <>
            {policy.actions.map((action, index) => (
              <ActionBlock
                key={`${index}-${action.type}`}
                action={action}
                variant={variants.get(action.type)}
                root={schema}
                onInvalid={reportInvalid(index)}
                onChange={(changed) =>
                  setPolicy({ ...policy, actions: policy.actions.with(index, changed) })
                }
                onRemove={() =>
                  setPolicy({ ...policy, actions: policy.actions.filter((_, i) => i !== index) })
                }
              />
            ))}
            <div className="flex items-end gap-2">
              <Select
                aria-label="Add an action"
                options={[...variants.keys()].map((type) => ({ id: type, label: humanize(type) }))}
                value={undefined}
                placeholder="Add an action…"
                onChange={(type) =>
                  setPolicy({
                    ...policy,
                    actions: [...policy.actions, newAction(type, variants.get(type), schema)],
                  })
                }
              />
              <Plus className="mb-2 size-4 text-muted" />
            </div>
          </>
        }
        limits={
          <>
            <Switch
              label="Enabled"
              isSelected={policy.enabled}
              onChange={(enabled) => setPolicy({ ...policy, enabled })}
            />
            <Switch
              label="Stop: skip later policies once this one matched"
              isSelected={policy.stop === true}
              onChange={(stop) => {
                const { stop: _stop, ...rest } = policy
                setPolicy(stop ? { ...rest, stop: true } : rest)
              }}
            />
            <Switch
              label="Skip every analyzer on matching merge requests"
              isSelected={policy.skipAnalyzers === '*'}
              onChange={(all) => {
                const { skipAnalyzers: _skip, ...rest } = policy
                setPolicy(all ? { ...rest, skipAnalyzers: '*' } : rest)
              }}
            />
            {policy.skipAnalyzers === '*' ? null : (
              <AnalyzerPicker
                label="Skip these analyzers"
                value={policy.skipAnalyzers ?? []}
                onChange={(kinds) => {
                  const { skipAnalyzers: _skip, ...rest } = policy
                  setPolicy(kinds.length ? { ...rest, skipAnalyzers: kinds } : rest)
                }}
              />
            )}
          </>
        }
      />
      <ConfirmDialog
        isOpen={removing}
        onOpenChange={(open) => !open && setRemoving(false)}
        title={`Remove policy ${original?.name ?? ''}?`}
        confirmLabel="Remove"
        isPending={put.isPending || remove.isPending}
        onConfirm={() =>
          original && store(withoutPolicy(entry?.value, original.id), 'Policy removed')
        }
      >
        The other policies of this scope stay as they are.
      </ConfirmDialog>
    </>
  )
}
