import type {
  ReleaseEdits,
  ReleaseEntry,
  ReleasePlan,
  ReleaseRepoView,
  RepoRef,
} from '@holtkeeper/api'
import {
  BadgeCheck,
  CircleCheck,
  CircleDashed,
  CircleX,
  GitPullRequestArrow,
  Pencil,
  RotateCcw,
  Sparkles,
  Tag as TagIcon,
  Undo2,
} from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { usePatchReleaseView, useReleaseActions } from '../../api/queries.ts'
import { formatRelative } from '../../lib/format.ts'
import { awaitsAcceptance, checklistRows, stepBlockedBy } from '../../lib/release-timeline.ts'
import {
  actorName,
  bumpChoices,
  channelLabel,
  countLabel,
  entryGroups,
  failingGates,
  planTasks,
  previewEdits,
  renameEntry,
  toggleEntry,
} from '../../lib/releases.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  Checkbox,
  Dialog,
  Markdown,
  Segmented,
  SegmentedTabs,
  Tag,
  TextField,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { BumpTag, EntryGroupsView, TaskList } from './parts.tsx'

type Step = ReleasePlan['step']

const baseOf = (edits: ReleaseEdits): ReleaseEdits => {
  const { updatedAt: _at, updatedBy: _by, ...base } = edits
  return base
}

function EntryEditor({
  entry,
  onToggle,
  onRename,
}: {
  entry: ReleaseEntry
  onToggle: (include: boolean) => void
  onRename: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.text)
  const finish = () => {
    setEditing(false)
    if (draft.trim() !== entry.text) onRename(draft)
  }
  return (
    <div className={`flex items-start gap-2 ${entry.included ? '' : 'opacity-55'}`}>
      <Checkbox
        label={<span className="sr-only">Include {entry.text}</span>}
        isSelected={entry.included}
        onChange={onToggle}
      />
      {editing ? (
        <TextField
          aria-label="Entry text"
          value={draft}
          onChange={setDraft}
          autoFocus
          className="flex-1"
          onKeyDown={(event) => {
            if (event.key === 'Enter') finish()
            if (event.key === 'Escape') {
              setDraft(entry.text)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
          <span className={entry.text !== entry.title ? 'text-[var(--brand)]' : ''}>
            {entry.text}
          </span>
          {entry.excludedBy && entry.excludedBy !== 'person' ? (
            <Tag tone="warning">
              {entry.excludedBy === 'rule' ? 'left out by type' : 'reverted'}
            </Tag>
          ) : null}
          <button
            type="button"
            aria-label="Edit text"
            className="text-muted hover:text-foreground"
            onClick={() => {
              setDraft(entry.text)
              setEditing(true)
            }}
          >
            <Pencil className="size-3" />
          </button>
        </span>
      )}
    </div>
  )
}

function VersionDialog({
  plan,
  scheme,
  open,
  onClose,
  onChange,
}: {
  plan: ReleasePlan
  scheme: 'semver' | 'calver'
  open: boolean
  onClose: () => void
  onChange: (version: string | undefined) => void
}) {
  const choices = scheme === 'semver' ? bumpChoices(plan.current?.version) : {}
  const bumps = (['patch', 'minor', 'major'] as const).filter((bump) => choices[bump])
  const [custom, setCustom] = useState(plan.edits.version ?? '')
  const chosen =
    plan.edits.version === undefined
      ? 'suggested'
      : (bumps.find((bump) => choices[bump] === plan.edits.version) ?? 'custom')
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title="Change the version"
      description={`After ${plan.current?.tag ?? 'no version yet'}`}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={!custom.trim()}
            onPress={() => {
              onChange(custom.trim())
              onClose()
            }}
          >
            Use {custom.trim() || 'custom'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Segmented
          aria-label="Version"
          value={chosen}
          options={[
            { id: 'suggested', label: `${plan.suggested.version ?? '—'} suggested` },
            ...bumps.map((bump) => ({ id: bump, label: `${choices[bump]} ${bump}` })),
            ...(chosen === 'custom' ? [{ id: 'custom', label: 'custom' }] : []),
          ]}
          onChange={(id) => {
            const bump = bumps.find((candidate) => candidate === id)
            onChange(bump ? choices[bump] : undefined)
            onClose()
          }}
        />
        <TextField
          label="Custom version"
          placeholder={scheme === 'semver' ? '1.2.3' : '2026.11.0'}
          value={custom}
          onChange={setCustom}
          mono
        />
      </div>
    </Dialog>
  )
}

function Notes({
  plan,
  editable,
  agent,
  writing,
  onWrite,
  onSave,
}: {
  plan: ReleasePlan
  editable: boolean
  agent: boolean
  writing: boolean
  onWrite: () => void
  onSave: (markdown: string | undefined) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(plan.summary.markdown)
  const source =
    plan.summary.source === 'agent'
      ? 'written by AI'
      : plan.summary.source === 'person'
        ? 'edited by a person'
        : 'digest of the changelog'
  return (
    <details className="group rounded-lg border border-line">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted">
        <span className="font-medium text-foreground">What changed</span>
        <span>{source}</span>
      </summary>
      <div className="relative border-t border-line px-3 py-2">
        {editable ? (
          <span className="float-right ml-2 flex gap-1">
            {agent ? (
              <Tooltip content="Write with AI (fast tier, style from the Guide)">
                <Button
                  size="sm"
                  variant="ghost"
                  isIconOnly
                  aria-label="Write with AI"
                  onPress={onWrite}
                  isPending={writing}
                >
                  <Sparkles className="size-3.5" />
                </Button>
              </Tooltip>
            ) : null}
            <Tooltip content="Edit">
              <Button
                size="sm"
                variant="ghost"
                isIconOnly
                aria-label="Edit notes"
                onPress={() => {
                  setDraft(plan.summary.markdown)
                  setEditing(true)
                }}
              >
                <Pencil className="size-3.5" />
              </Button>
            </Tooltip>
            {plan.edits.summary ? (
              <Tooltip content="Back to the digest">
                <Button
                  size="sm"
                  variant="ghost"
                  isIconOnly
                  aria-label="Reset notes"
                  onPress={() => onSave(undefined)}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </Tooltip>
            ) : null}
          </span>
        ) : null}
        {plan.summary.markdown ? (
          <Markdown text={plan.summary.markdown} />
        ) : (
          <p className="text-sm text-muted">No notes.</p>
        )}
      </div>
      <Dialog
        isOpen={editing}
        onOpenChange={setEditing}
        title="What changed"
        size="lg"
        footer={
          <>
            <Button variant="tertiary" onPress={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onPress={() => {
                onSave(draft)
                setEditing(false)
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <TextField aria-label="Notes" value={draft} onChange={setDraft} multiline rows={12} />
      </Dialog>
    </details>
  )
}

function Accepted({ repo, view }: { repo: RepoRef; view: ReleaseRepoView }) {
  const actions = useReleaseActions()
  const accepted = view.row.acceptance
  if (!accepted) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <BadgeCheck className="size-3.5 text-ok" />
      <span>
        Accepted by <b>{actorName(view.people, accepted.by, accepted.name)}</b>{' '}
        {[channelLabel(accepted.channel), formatRelative(accepted.at)].filter(Boolean).join(' ')}
        {accepted.note ? `: ${accepted.note}` : ''}
      </span>
      {view.can.run && !view.readOnly ? (
        <Button
          size="sm"
          variant="ghost"
          isPending={actions.withdraw.isPending}
          onPress={() =>
            actions.withdraw.mutate(repo, {
              onError: (error) => notify.error('Not withdrawn', messageOf(error)),
            })
          }
        >
          <Undo2 className="size-3.5" />
          Withdraw
        </Button>
      ) : null}
    </div>
  )
}

const acceptanceHints: Record<ReleaseRepoView['settings']['acceptance'], string> = {
  none: '',
  manual: 'accept here, in the API or in chat',
  label: 'accept here or label the merged release MR release-accepted',
  merge: 'accept here or merge the release MR',
}

function GateChecklist({ plan, view }: { plan: ReleasePlan; view: ReleaseRepoView }) {
  const rows = checklistRows(plan, view.settings.changelogFile)
  return (
    <ul aria-label="Gates" className="flex flex-col gap-1.5 text-xs">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-wrap items-center gap-2">
          {row.ok ? (
            <CircleCheck className="size-3.5 shrink-0 text-ok" />
          ) : row.severity === 'info' ? (
            <CircleDashed className="size-3.5 shrink-0 text-muted" />
          ) : (
            <CircleX
              className={`size-3.5 shrink-0 ${row.severity === 'block' ? 'text-bad' : 'text-warn'}`}
            />
          )}
          <span>{row.text}</span>
          {row.key.startsWith('acceptance') &&
          !row.ok &&
          acceptanceHints[view.settings.acceptance] ? (
            <span className="text-muted">{acceptanceHints[view.settings.acceptance]}</span>
          ) : null}
          {row.detail ? <span className="text-muted">{row.detail}</span> : null}
          <span className="flex-1" />
          <Tag tone={row.ok ? 'default' : row.tone}>{row.severityText}</Tag>
        </li>
      ))}
    </ul>
  )
}

function ConfirmStep({
  view,
  plan,
  step,
  label,
  open,
  onClose,
}: {
  view: ReleaseRepoView
  plan: ReleasePlan
  step: Step
  label: string
  open: boolean
  onClose: () => void
}) {
  const actions = useReleaseActions()
  const [force, setForce] = useState(false)
  const [writeNotes, setWriteNotes] = useState(false)
  const { soft } = failingGates(plan.gates)
  const included = plan.entries.filter((entry) => entry.included).length
  const canWrite = step === 'propose' && view.agent && plan.summary.source !== 'person'
  const run = () =>
    actions.step.mutate(
      {
        step,
        repo: repoKey(view.repo),
        ...(force ? { force } : {}),
        ...(canWrite && writeNotes ? { writeNotes } : {}),
      },
      {
        onSuccess: (result) => {
          onClose()
          setForce(false)
          notify.success(result.dryRun ? `Dry run: ${result.detail}` : result.detail)
        },
        onError: (error) => notify.error('Not done', messageOf(error)),
      },
    )
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={label}
      description={view.repo.path}
      size="lg"
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onPress={run}
            isPending={actions.step.isPending}
            isDisabled={soft.length > 0 && !force}
          >
            {label}
          </Button>
        </>
      }
    >
      <ul className="list-disc pl-5 text-sm">
        {step === 'propose' ? (
          <li>
            {view.row.request ? 'Rewrites the title and description of' : 'Opens'} a merge request
            from <b className="mono">{plan.range.toLabel}</b> into{' '}
            <b className="mono">{plan.range.fromLabel}</b>: “{plan.title}”.
          </li>
        ) : (
          <>
            {view.settings.changelogFile ? (
              <li>
                Commits the notes to <b className="mono">CHANGELOG.md</b> on {plan.range.toLabel}.
              </li>
            ) : null}
            <li>
              Tags <b className="mono">{plan.range.toLabel}</b> as{' '}
              <b className="mono">{plan.tag}</b> and creates a release “{plan.title}”.
            </li>
          </>
        )}
        <li>{included} changelog entries.</li>
      </ul>
      <details className="rounded-lg border border-line">
        <summary className="cursor-pointer px-3 py-2 text-xs text-muted">
          Preview the {step === 'propose' ? 'merge request' : 'release'} text
        </summary>
        <div className="max-h-80 overflow-y-auto border-t border-line px-3 py-2">
          <Markdown text={plan.body.replace('<!-- holtkeeper:release -->', '')} />
        </div>
      </details>
      {canWrite ? (
        <Checkbox
          label="Write the notes with AI first (one fast-tier call)"
          isSelected={writeNotes}
          onChange={setWriteNotes}
        />
      ) : null}
      {soft.length ? (
        <div className="flex flex-col gap-2 rounded-lg border border-[color-mix(in_oklab,var(--warn)_24%,transparent)] bg-[color-mix(in_oklab,var(--warn)_11%,transparent)] p-3 text-sm">
          <span className="font-medium">Failing checks</span>
          <ul className="list-disc pl-5">
            {soft.map((gate) => (
              <li key={gate.message}>{gate.message}</li>
            ))}
          </ul>
          <Checkbox
            label="Do it anyway; the override is recorded"
            isSelected={force}
            onChange={setForce}
          />
        </div>
      ) : null}
    </Dialog>
  )
}

/**
 * The unreleased version on top of the timeline: the bump row (current → suggested version, the
 * bump and why), the pending changes grouped by type, their tasks and notes, then the gates
 * checklist with each gate's severity and whether the changelog is ready. Accept shows only when
 * the caller may accept (`can.accept`) and the version waits for it; the step's button, behind a
 * confirmation, stays off while a hard gate fails or the acceptance is missing. With both a
 * version and a release candidate pending, a switch picks which one it shows.
 */
export function NextCard({
  repo,
  view,
  compact = false,
}: {
  repo: RepoRef
  view: ReleaseRepoView
  /** One column, for a side sheet. */
  compact?: boolean
}) {
  const actions = useReleaseActions()
  const patchView = usePatchReleaseView()
  const plans = [
    ...(view.version ? [{ step: 'version' as const, plan: view.version }] : []),
    ...(view.proposal ? [{ step: 'propose' as const, plan: view.proposal }] : []),
  ]
  const [chosen, setChosen] = useState<Step>()
  const [editingEntries, setEditingEntries] = useState(false)
  const [changingVersion, setChangingVersion] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const current = plans.find((candidate) => candidate.step === chosen) ?? plans[0]
  const editable = view.can.run && !view.readOnly

  if (!current)
    return (
      <section className="rounded-xl border border-dashed border-line-strong p-4">
        <h2 className="text-xs text-dim">Next</h2>
        <p className="mt-1 text-sm text-muted">
          Nothing to release: {view.row.latest?.tag ?? 'the target branch'} holds every change
          {view.settings.flow.mode === 'merge-request'
            ? ` and ${view.settings.flow.source} has nothing new`
            : ''}
          .
        </p>
      </section>
    )

  const { step, plan } = current
  const base = baseOf(plan.edits)
  const key = step === 'propose' ? 'proposal' : 'version'
  const save = (edits: ReleaseEdits) => {
    patchView(repo, (data) =>
      data[key] ? { ...data, [key]: previewEdits(data[key], edits) } : data,
    )
    actions.edits.mutate(
      { repo: repoKey(repo), step, edits },
      { onError: (error) => notify.error('Not saved', messageOf(error)) },
    )
  }
  const blocked = stepBlockedBy(step, plan.gates, view.row)
  const canAccept = view.can.accept && !view.readOnly && awaitsAcceptance(view.row)
  const tasks = planTasks(plan.entries, view.issues)
  const leftOut = entryGroups(plan.entries).leftOut.length
  const label =
    step === 'propose'
      ? view.row.request
        ? `Update !${view.row.request.id}`
        : 'Open release MR'
      : `Create ${plan.tag ?? 'version'}`

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-line-strong bg-panel p-4">
      <header className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-dim">Next release</span>
        <div className="flex items-baseline gap-2">
          <span className="mono text-sm text-muted">{plan.current?.tag ?? 'no version'}</span>
          <span className="text-muted">→</span>
          <span className="mono text-xl font-semibold">{plan.tag ?? '—'}</span>
        </div>
        <BumpTag bump={plan.suggested.bump} />
        {editable && step === 'version' ? (
          <Button size="sm" variant="ghost" onPress={() => setChangingVersion(true)}>
            Change version
          </Button>
        ) : null}
        <span className="text-xs text-muted">
          {countLabel(plan.commitCount, plan.capped)} on{' '}
          <span className="mono">{plan.range.toLabel}</span>
          {step === 'version' && view.row.waitingSince
            ? ` · waiting since ${formatRelative(view.row.waitingSince)}`
            : ''}
        </span>
        {plans.length > 1 ? (
          <SegmentedTabs
            aria-label="Pending step"
            className="ms-auto"
            items={plans.map((candidate) => ({
              id: candidate.step,
              label:
                candidate.step === 'version'
                  ? `Version · ${countLabel(view.row.unreleased, view.row.unreleasedCapped)}`
                  : `Release MR · ${countLabel(view.row.ahead, view.row.aheadCapped)}`,
            }))}
            selected={step}
            onSelect={(id) => setChosen(id === 'propose' ? 'propose' : 'version')}
          />
        ) : null}
      </header>
      {plan.suggested.reasons.length ? (
        <p className="-mt-2 text-xs text-dim">
          Bump from commit conventions:{' '}
          {plan.suggested.reasons.map((reason) => reason.because).join(' · ')}
        </p>
      ) : null}

      <div
        className={
          compact ? 'grid gap-4' : 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]'
        }
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs text-dim">
              Changes · {countLabel(plan.commitCount, plan.capped)}
              {leftOut ? ` · ${leftOut} left out` : ''}
            </h3>
            {plan.compareUrl ? (
              <a
                href={plan.compareUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted hover:text-foreground hover:underline"
              >
                Compare
              </a>
            ) : null}
            {editable ? (
              <Button
                size="sm"
                variant="ghost"
                className="ms-auto"
                onPress={() => setEditingEntries((on) => !on)}
              >
                {editingEntries ? 'Done' : 'Edit entries'}
              </Button>
            ) : null}
          </div>
          {editingEntries ? (
            <ul className="flex flex-col gap-1.5">
              {plan.entries.map((entry) => (
                <li key={entry.id}>
                  <EntryEditor
                    entry={entry}
                    onToggle={(include) => save(toggleEntry(base, entry, include))}
                    onRename={(text) => save(renameEntry(base, entry, text))}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <EntryGroupsView entries={plan.entries} />
          )}
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <h3 className="text-xs text-dim">Tasks · {tasks.length}</h3>
            <TaskList tasks={tasks} />
          </div>
          <Notes
            key={plan.summary.markdown}
            plan={plan}
            editable={editable}
            agent={view.agent}
            writing={actions.summary.isPending}
            onWrite={() =>
              actions.summary.mutate(
                { repo: repoKey(repo), step },
                { onError: (error) => notify.error('The agent did not answer', messageOf(error)) },
              )
            }
            onSave={(markdown) => {
              const { summary: _old, ...rest } = base
              save(
                markdown === undefined
                  ? rest
                  : {
                      ...rest,
                      summary: { markdown, source: 'person', at: new Date().toISOString() },
                    },
              )
            }}
          />
        </div>
      </div>

      <footer className="flex flex-col gap-3 border-t border-line pt-3">
        <GateChecklist plan={plan} view={view} />
        {step === 'version' ? <Accepted repo={repo} view={view} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-xs text-muted">
            {editable && blocked
              ? blocked
              : editable
                ? step === 'propose'
                  ? `Opening asks to confirm: a merge request from ${plan.range.toLabel} into ${plan.range.fromLabel ?? 'the target branch'}`
                  : `Creating asks to confirm: ${view.settings.changelogFile ? 'commits the notes to CHANGELOG.md, ' : ''}tags ${plan.range.toLabel}`
                : view.readOnly
                  ? 'The repository is read-only for Holtkeeper.'
                  : 'Your grants do not include releases:run here.'}
          </span>
          {step === 'version' && canAccept ? (
            <Button
              variant={blocked ? 'primary' : 'secondary'}
              isPending={actions.accept.isPending}
              onPress={() =>
                actions.accept.mutate(
                  { repo: repoKey(repo) },
                  {
                    onSuccess: (result) => notify.success(result.detail),
                    onError: (error) => notify.error('Not accepted', messageOf(error)),
                  },
                )
              }
            >
              <BadgeCheck className="size-4" />
              Accept {plan.version ?? ''}
            </Button>
          ) : null}
          {editable ? (
            <Button
              variant={blocked ? 'secondary' : 'primary'}
              isDisabled={blocked !== undefined}
              onPress={() => setConfirming(true)}
            >
              {step === 'propose' ? (
                <GitPullRequestArrow className="size-4" />
              ) : (
                <TagIcon className="size-4" />
              )}
              {label}
            </Button>
          ) : null}
        </div>
      </footer>

      {step === 'version' ? (
        <VersionDialog
          key={plan.edits.version ?? ''}
          plan={plan}
          scheme={view.settings.version.scheme}
          open={changingVersion}
          onClose={() => setChangingVersion(false)}
          onChange={(version) => {
            const { version: _old, ...rest } = base
            save(version === undefined ? rest : { ...rest, version })
          }}
        />
      ) : null}
      <ConfirmStep
        view={view}
        plan={plan}
        step={step}
        label={label}
        open={confirming}
        onClose={() => setConfirming(false)}
      />
    </section>
  )
}
