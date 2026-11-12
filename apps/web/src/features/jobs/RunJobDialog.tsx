import type { JobAnalyzerView, RepoRef } from '@holtkeeper/api'
import { useNavigate } from '@tanstack/react-router'
import { Play } from 'lucide-react'
import { type ReactNode, useCallback, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useGroups,
  useGroupTitles,
  useJobAnalyzers,
  useJobMutations,
  useRepos,
} from '../../api/queries.ts'
import { analyzersFor } from '../../lib/jobs.ts'
import { repoKey } from '../../lib/repo.ts'
import { defaultValue } from '../../lib/schema.ts'
import type { ButtonVariant } from '../../ui/Button.tsx'
import { Button, Dialog, Notice, Placeholder, Select, TextField, notify } from '../../ui/index.ts'
import type { PageAction } from '../../ui/Page.tsx'
import { PresetPicker } from '../settings/PresetPicker.tsx'
import { StructuredEditor } from '../settings/SchemaField.tsx'
import { useSession } from '../shell/session.ts'

interface Target {
  repo?: RepoRef | undefined
  group?: string | undefined
  analyzer?: string | undefined
}

/** Queues one analyzer run for a repository or group and opens the new job on success. */
function RunJobDialog({
  isOpen,
  onOpenChange,
  ...target
}: Target & { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  if (!isOpen) return null
  return <RunJobForm {...target} onClose={() => onOpenChange(false)} />
}

function RunJobForm({
  repo,
  group,
  analyzer: initialKind,
  onClose,
}: Target & { onClose: () => void }) {
  const navigate = useNavigate()
  const titleOf = useGroupTitles()
  const analyzers = useJobAnalyzers()
  const { create } = useJobMutations()
  const available = analyzersFor(analyzers.data?.analyzers ?? [], { repo, group })
  const [kind, setKind] = useState<string | undefined>(initialKind)
  const selected =
    available.find((a) => a.kind === kind) ?? (available.length === 1 ? available[0] : undefined)
  const [draft, setDraft] = useState<{ kind: string; value: unknown }>()
  const selectedKind = selected?.kind
  const options = selected
    ? draft?.kind === selected.kind
      ? draft.value
      : defaultValue(selected.schema)
    : undefined
  const setOptions = useCallback(
    (value: unknown) => {
      if (selectedKind !== undefined) setDraft({ kind: selectedKind, value })
    },
    [selectedKind],
  )
  const [applied, setApplied] = useState(0)
  const [targetRepo, setTargetRepo] = useState<string | undefined>()
  const [targetGroup, setTargetGroup] = useState<string | undefined>()
  const [ref, setRef] = useState('')

  const fixed = repo !== undefined || group !== undefined
  const repoValue = repo ? repoKey(repo) : selected?.scope === 'repo' ? targetRepo : undefined
  const groupValue = group ?? (selected?.scope === 'group' ? targetGroup : undefined)
  const invalid =
    !selected || options === undefined || (selected.scope === 'repo' ? !repoValue : !groupValue)

  const pick = (next: string) => {
    setKind(next)
    setDraft(undefined)
    setApplied((count) => count + 1)
  }

  const submit = () => {
    if (!selected || invalid) return
    create.mutate(
      {
        analyzer: selected.kind,
        ...(selected.scope === 'repo' && repoValue ? { repo: repoValue } : {}),
        ...(selected.scope === 'group' && groupValue ? { group: groupValue } : {}),
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        ...(isRecord(options) ? { options } : {}),
      },
      {
        onSuccess: (job) => {
          notify.success('Job queued', selected.label)
          onClose()
          void navigate({ to: '/ops/runs/$jobId', params: { jobId: job.id } })
        },
      },
    )
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title="Run analyzer"
      description={
        repo
          ? repo.path
          : group
            ? `Group ${titleOf(group)}`
            : 'Queue a background run of an analyzer'
      }
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onPress={submit}
            isDisabled={invalid}
            isPending={create.isPending}
          >
            <Play className="size-3.5" />
            Queue job
          </Button>
        </>
      }
    >
      {analyzers.isPending ? (
        <Placeholder className="h-40" />
      ) : analyzers.isError ? (
        <Notice tone="danger" title="Analyzers not loaded">
          {messageOf(analyzers.error)}
        </Notice>
      ) : available.length === 0 ? (
        <Notice title="No analyzers">
          {group ? 'No analyzer runs on a group.' : 'No analyzer runs on a repository.'}
        </Notice>
      ) : (
        <div className="flex flex-col gap-4">
          {create.error ? (
            <Notice tone="danger" title="Not queued">
              {messageOf(create.error)}
            </Notice>
          ) : null}
          <Select
            label="Analyzer"
            options={available.map((a) => ({
              id: a.kind,
              label: a.label,
              text: a.label,
            }))}
            value={selected?.kind}
            onChange={pick}
          />
          {selected && !fixed ? (
            selected.scope === 'repo' ? (
              <RepoPicker value={targetRepo} onChange={setTargetRepo} />
            ) : (
              <GroupPicker value={targetGroup} onChange={setTargetGroup} />
            )
          ) : null}
          {selected ? (
            <>
              <TextField
                label="Ref"
                value={ref}
                onChange={setRef}
                mono
                placeholder="Default branch"
                description="Release, tag or commit to analyze; empty runs on the default branch."
              />
              {selected.presets && selected.presets.length > 0 ? (
                <PresetPicker
                  presets={selected.presets}
                  value={options}
                  onApply={(next) => {
                    setOptions(next)
                    setApplied((count) => count + 1)
                  }}
                />
              ) : null}
              <StructuredEditor
                key={`${selected.kind}:${applied}`}
                schema={selected.schema}
                initial={options}
                onChange={setOptions}
                label="Options"
              />
              <Needs analyzer={selected} />
            </>
          ) : null}
        </div>
      )}
    </Dialog>
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function RepoPicker({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (value: string) => void
}) {
  const repos = useRepos()
  if (repos.isPending) return <Placeholder className="h-14" />
  if (repos.isError)
    return (
      <Notice tone="danger" title="Repositories not loaded">
        {messageOf(repos.error)}
      </Notice>
    )
  return (
    <Select
      label="Repository"
      placeholder="Pick a repository…"
      options={repos.data.repos.map(({ repo }) => ({
        id: repoKey(repo),
        label: repo.path,
        text: repo.path,
      }))}
      value={value}
      onChange={onChange}
    />
  )
}

function GroupPicker({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (value: string) => void
}) {
  const groups = useGroups()
  const titleOf = useGroupTitles()
  if (groups.isPending) return <Placeholder className="h-14" />
  if (groups.isError)
    return (
      <Notice tone="danger" title="Groups not loaded">
        {messageOf(groups.error)}
      </Notice>
    )
  return (
    <Select
      label="Group"
      placeholder="Pick a group…"
      options={groups.data.entries.map((entry) => ({
        id: entry.id,
        label: (
          <span className="flex items-baseline gap-2">
            {titleOf(entry.id)}
            {titleOf(entry.id) === entry.id ? null : (
              <span className="mono text-[11px] text-muted">{entry.id}</span>
            )}
          </span>
        ),
        text: titleOf(entry.id),
      }))}
      value={value}
      onChange={onChange}
    />
  )
}

function Needs({ analyzer }: { analyzer: JobAnalyzerView }) {
  const needs = [
    analyzer.needs.checkout ? 'a checkout' : undefined,
    analyzer.needs.forge ? 'forge access' : undefined,
    analyzer.needs.history ? 'the full git history' : undefined,
    analyzer.needs.agent === 'required'
      ? 'an AI agent'
      : analyzer.needs.agent === 'optional'
        ? 'an AI agent when configured'
        : undefined,
  ].filter((need) => need !== undefined)
  if (!needs.length) return null
  return <p className="text-xs text-muted">Uses {needs.join(', ')}.</p>
}

/**
 * The header action that opens `RunJobDialog`, with the dialog to render next to it. `action` is
 * `undefined` without `analyses:run`, while the analyzers load or when no analyzer fits the target.
 */
export function useRunJob({
  repo,
  group,
  analyzer,
  label = 'Run analyzer',
}: Target & { label?: string }): { action: PageAction | undefined; dialog: ReactNode } {
  const { can } = useSession()
  const analyzers = useJobAnalyzers()
  const [open, setOpen] = useState(false)
  const available = analyzers.data ? analyzersFor(analyzers.data.analyzers, { repo, group }) : []
  const fits =
    can('analyses:run') &&
    available.length > 0 &&
    (!analyzer || available.some((a) => a.kind === analyzer))
  return {
    action: fits ? { label, icon: Play, onPress: () => setOpen(true) } : undefined,
    dialog: (
      <RunJobDialog
        isOpen={open}
        onOpenChange={setOpen}
        repo={repo}
        group={group}
        analyzer={analyzer}
      />
    ),
  }
}

/**
 * Opens `RunJobDialog`; renders nothing without `analyses:run`, when jobs are off or when no
 * analyzer fits the target.
 */
export function RunJobButton({
  label = 'Run analyzer',
  variant = 'primary',
  size = 'md',
  ...target
}: Target & { label?: string; variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg' }) {
  const run = useRunJob({ ...target, label })
  if (!run.action) return null
  return (
    <>
      <Button variant={variant} size={size} onPress={run.action.onPress}>
        <Play className="size-3.5" />
        {label}
      </Button>
      {run.dialog}
    </>
  )
}
