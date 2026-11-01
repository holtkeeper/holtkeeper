import type {
  ReleaseEdits,
  ReleaseEntry,
  ReleasePlan,
  ReleaseRepoView,
  RepoRef,
} from '@holtkeeper/api'
import {
  CircleCheck,
  CircleX,
  GitPullRequestArrow,
  Pencil,
  RotateCcw,
  Sparkles,
  Tag,
} from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { usePatchReleaseView, useReleaseActions } from '../../api/queries.ts'
import {
  bumpChoices,
  entrySections,
  failingGates,
  previewEdits,
  renameEntry,
  toggleEntry,
} from '../../lib/releases.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  Markdown,
  Panel,
  Segmented,
  TextField,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { BumpChip } from './parts.tsx'

type Step = ReleasePlan['step']

function EntryRow({
  entry,
  editable,
  onToggle,
  onRename,
}: {
  entry: ReleaseEntry
  editable: boolean
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
    <li className={`flex items-start gap-3 py-2 ${entry.included ? '' : 'opacity-55'}`}>
      <Checkbox
        label={<span className="sr-only">Include {entry.text}</span>}
        isSelected={entry.included}
        onChange={onToggle}
        isDisabled={!editable}
      />
      <div className="min-w-0 flex-1">
        {editing ? (
          <TextField
            aria-label="Entry text"
            value={draft}
            onChange={setDraft}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') finish()
              if (event.key === 'Escape') {
                setDraft(entry.text)
                setEditing(false)
              }
            }}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {entry.scope ? <span className="font-semibold">{entry.scope}:</span> : null}
            <span className={entry.text !== entry.title ? 'text-accent' : ''}>{entry.text}</span>
            {editable ? (
              <button
                type="button"
                aria-label="Edit text"
                className="text-muted hover:text-foreground"
                onClick={() => {
                  setDraft(entry.text)
                  setEditing(true)
                }}
              >
                <Pencil className="size-3.5" />
              </button>
            ) : null}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted">
          {entry.breaking ? <Chip tone="danger">breaking</Chip> : null}
          {entry.type ? <Chip>{entry.type}</Chip> : null}
          {entry.tickets.map((ticket) => (
            <Chip key={ticket} tone="accent" variant="tertiary">
              {ticket}
            </Chip>
          ))}
          {entry.mergeRequests.map((n) => (
            <span key={n}>!{n}</span>
          ))}
          <Tooltip
            content={
              <ul className="max-w-sm text-xs">
                {entry.commits.slice(0, 8).map((commit) => (
                  <li key={commit.sha}>
                    <span className="font-mono">{commit.sha.slice(0, 8)}</span> {commit.subject} —{' '}
                    {commit.author}
                  </li>
                ))}
              </ul>
            }
          >
            <span tabIndex={0} className="cursor-default underline decoration-dotted">
              {entry.commits.length === 1 ? '1 commit' : `${entry.commits.length} commits`}
            </span>
          </Tooltip>
          <span>· {entry.authors.join(', ')}</span>
          {entry.excludedBy === 'rule' ? <Chip tone="warning">left out by a rule</Chip> : null}
          {entry.excludedBy === 'revert' ? (
            <Chip tone="warning">reverted in this release</Chip>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function VersionPicker({
  plan,
  scheme,
  editable,
  onChange,
}: {
  plan: ReleasePlan
  scheme: 'semver' | 'calver'
  editable: boolean
  onChange: (version: string | undefined) => void
}) {
  const choices = scheme === 'semver' ? bumpChoices(plan.current?.version) : {}
  const suggested = plan.suggested.version
  const options = [
    ...(suggested ? [{ id: 'suggested', label: `${suggested} (suggested)` }] : []),
    ...(['patch', 'minor', 'major'] as const)
      .filter((bump) => choices[bump] && choices[bump] !== suggested)
      .map((bump) => ({ id: bump, label: `${choices[bump]} (${bump})` })),
    { id: 'custom', label: 'Custom' },
  ]
  const chosen =
    plan.edits.version === undefined
      ? 'suggested'
      : ((['patch', 'minor', 'major'] as const).find(
          (bump) => choices[bump] === plan.edits.version,
        ) ?? 'custom')
  const [custom, setCustom] = useState(plan.edits.version ?? '')
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-sm text-muted">
          {plan.current?.tag ?? 'no version yet'}
        </span>
        <span className="text-muted">→</span>
        <span className="font-mono text-2xl font-semibold">{plan.tag ?? '—'}</span>
        <BumpChip bump={plan.suggested.bump} />
      </div>
      {editable ? (
        <div className="flex flex-wrap items-end gap-2">
          <Segmented
            aria-label="Version"
            value={chosen}
            options={options}
            onChange={(id) => {
              if (id === 'suggested') onChange(undefined)
              else if (id === 'custom') setCustom(plan.version ?? '')
              else {
                const bump = (['patch', 'minor', 'major'] as const).find((b) => b === id)
                if (bump) onChange(choices[bump])
              }
            }}
          />
        </div>
      ) : null}
      {editable ? (
        <div className="flex items-end gap-2">
          <TextField
            aria-label="Custom version"
            placeholder={scheme === 'semver' ? '1.2.3' : '2026.11.0'}
            value={custom}
            onChange={setCustom}
            mono
            className="w-48"
          />
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!custom.trim() || custom.trim() === plan.version}
            onPress={() => onChange(custom.trim())}
          >
            Use
          </Button>
        </div>
      ) : null}
      {plan.suggested.reasons.length ? (
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {plan.suggested.reasons.map((reason) => (
            <li key={`${reason.bump}-${reason.because}`}>
              <BumpChip bump={reason.bump} /> {reason.because}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function SummaryCard({
  plan,
  editable,
  agent,
  onSave,
  onWrite,
  writing,
}: {
  plan: ReleasePlan
  editable: boolean
  agent: boolean
  onSave: (markdown: string | undefined) => void
  onWrite: () => void
  writing: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(plan.summary.markdown)
  return (
    <Panel
      title="What changed"
      description={
        plan.summary.source === 'agent'
          ? 'Written by the AI agent'
          : plan.summary.source === 'person'
            ? 'Edited by a person'
            : plan.summary.source === 'changelog'
              ? 'Digest of the changelog'
              : 'Off in the release flow'
      }
      actions={
        editable ? (
          <div className="flex gap-1">
            {agent ? (
              <Tooltip content="Have the AI agent write it">
                <Button
                  size="sm"
                  variant="ghost"
                  isIconOnly
                  aria-label="Write with AI"
                  onPress={onWrite}
                  isPending={writing}
                >
                  <Sparkles className="size-4" />
                </Button>
              </Tooltip>
            ) : null}
            <Tooltip content="Edit">
              <Button
                size="sm"
                variant="ghost"
                isIconOnly
                aria-label="Edit summary"
                onPress={() => {
                  setDraft(plan.summary.markdown)
                  setEditing(true)
                }}
              >
                <Pencil className="size-4" />
              </Button>
            </Tooltip>
            {plan.edits.summary ? (
              <Tooltip content="Back to the automatic summary">
                <Button
                  size="sm"
                  variant="ghost"
                  isIconOnly
                  aria-label="Reset summary"
                  onPress={() => onSave(undefined)}
                >
                  <RotateCcw className="size-4" />
                </Button>
              </Tooltip>
            ) : null}
          </div>
        ) : null
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <TextField aria-label="Summary" value={draft} onChange={setDraft} multiline rows={8} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="tertiary" onPress={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onPress={() => {
                onSave(draft)
                setEditing(false)
              }}
            >
              Save
            </Button>
          </div>
        </div>
      ) : plan.summary.markdown ? (
        <Markdown text={plan.summary.markdown} />
      ) : (
        <p className="text-sm text-muted">No summary.</p>
      )}
    </Panel>
  )
}

function GateList({ plan }: { plan: ReleasePlan }) {
  if (!plan.gates.length) return null
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {plan.gates.map((gate) => (
        <li key={`${gate.id}-${gate.message}`} className="flex items-start gap-2">
          {gate.ok ? (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
          ) : (
            <CircleX className="mt-0.5 size-4 shrink-0 text-danger" />
          )}
          <span className={gate.ok ? 'text-muted' : ''}>{gate.message}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * One step's plan, editable: version, changelog entries, summary, the resulting merge request or
 * release text, gates and the button that runs the step after a confirmation.
 */
export function PlanWorkspace({
  repo,
  view,
  plan,
  step,
  extra,
}: {
  repo: RepoRef
  view: ReleaseRepoView
  plan: ReleasePlan
  step: Step
  extra?: React.ReactNode
}) {
  const actions = useReleaseActions()
  const patchView = usePatchReleaseView()
  const editable = view.can.run && !view.readOnly
  const [confirming, setConfirming] = useState(false)
  const [force, setForce] = useState(false)
  const [preview, setPreview] = useState(false)
  const key = step === 'propose' ? 'proposal' : 'version'
  const { hard, soft } = failingGates(plan.gates)

  const save = (edits: ReleaseEdits) => {
    patchView(repo, (current) =>
      current[key] ? { ...current, [key]: previewEdits(current[key], edits) } : current,
    )
    actions.edits.mutate(
      { repo: repoKey(repo), step, edits },
      { onError: (error) => notify.error('Not saved', messageOf(error)) },
    )
  }
  const { updatedAt: _at, updatedBy: _by, ...base } = plan.edits

  const run = () =>
    actions.step.mutate(
      { step, repo: repoKey(repo), force },
      {
        onSuccess: (result) => {
          setConfirming(false)
          setForce(false)
          notify.success(result.dryRun ? `Dry run: ${result.detail}` : result.detail)
        },
        onError: (error) => notify.error('Not done', messageOf(error)),
      },
    )

  const sections = entrySections(plan.entries)
  const included = plan.entries.filter((entry) => entry.included).length
  const actionLabel =
    step === 'propose'
      ? view.row.request
        ? `Update !${view.row.request.id}`
        : 'Open merge request'
      : `Create ${plan.tag ?? 'version'}`

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
      <div className="flex min-w-0 flex-col gap-6">
        <Panel
          title={step === 'propose' ? 'Version if released after merging' : 'Version'}
          description={`${plan.range.fromLabel ?? 'start'} → ${plan.range.toLabel}`}
          actions={
            plan.compareUrl ? (
              <a
                href={plan.compareUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm hover:underline"
              >
                Compare
              </a>
            ) : null
          }
        >
          <VersionPicker
            plan={plan}
            scheme={view.settings.version.scheme}
            editable={editable && step === 'version'}
            onChange={(version) => {
              const { version: _old, ...rest } = base
              save(version === undefined ? rest : { ...rest, version })
            }}
          />
        </Panel>
        <Panel
          title="Changelog"
          description={`${included} of ${plan.entries.length} entries from ${plan.commitCount}${plan.capped ? '+' : ''} commits; repeated messages appear once`}
        >
          {sections.length === 0 ? (
            <p className="text-sm text-muted">No changes.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {sections.map((section) => (
                <section key={section.id}>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                    {section.title}
                  </h3>
                  <ul className="divide-y divide-separator">
                    {section.entries.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        editable={editable}
                        onToggle={(include) => save(toggleEntry(base, entry, include))}
                        onRename={(text) => save(renameEntry(base, entry, text))}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Panel>
      </div>
      <div className="flex flex-col gap-6 lg:sticky lg:top-4 lg:self-start">
        <SummaryCard
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
        {extra}
        <Panel
          title={step === 'propose' ? 'Merge request' : 'Release'}
          description={plan.title}
          actions={
            <Button size="sm" variant="ghost" onPress={() => setPreview(true)}>
              Preview
            </Button>
          }
        >
          <div className="flex flex-col gap-4">
            <GateList plan={plan} />
            {editable ? (
              <Button
                variant="primary"
                fullWidth
                isDisabled={hard.length > 0}
                onPress={() => setConfirming(true)}
              >
                {step === 'propose' ? (
                  <GitPullRequestArrow className="size-4" />
                ) : (
                  <Tag className="size-4" />
                )}
                {actionLabel}
              </Button>
            ) : (
              <p className="text-sm text-muted">
                {view.readOnly
                  ? 'The repository is read-only for Holtkeeper.'
                  : 'Your grants do not include releases:run here.'}
              </p>
            )}
          </div>
        </Panel>
      </div>
      <Dialog isOpen={preview} onOpenChange={setPreview} title={plan.title} size="lg">
        <Markdown text={plan.body.replace('<!-- holtkeeper:release -->', '')} />
      </Dialog>
      <Dialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title={actionLabel}
        description={view.repo.path}
        footer={
          <>
            <Button variant="tertiary" onPress={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onPress={run}
              isPending={actions.step.isPending}
              isDisabled={soft.length > 0 && !force}
            >
              {actionLabel}
            </Button>
          </>
        }
      >
        <ul className="list-disc pl-5 text-sm">
          {step === 'propose' ? (
            <li>
              {view.row.request ? 'Rewrites the title and description of' : 'Opens'} a merge request
              from <b>{plan.range.toLabel}</b> into <b>{plan.range.fromLabel}</b>: “{plan.title}”.
            </li>
          ) : (
            <>
              {view.settings.tag.changelogFile.enabled ? (
                <li>
                  Commits the notes to <b>{view.settings.tag.changelogFile.path}</b> on{' '}
                  {plan.range.toLabel}.
                </li>
              ) : null}
              <li>
                Tags <b>{plan.range.toLabel}</b> as <b>{plan.tag}</b>.
              </li>
              {view.settings.tag.release ? (
                <li>Creates a release “{plan.title}” with the notes.</li>
              ) : null}
              {view.settings.deploy.environments
                .filter((env) => env.auto && !env.after)
                .map((env) => (
                  <li key={env.name}>Starts the deploy to {env.name} once its job is ready.</li>
                ))}
            </>
          )}
          <li>{included} changelog entries.</li>
        </ul>
        {soft.length ? (
          <div className="flex flex-col gap-2 rounded-xl bg-warning-soft p-3 text-sm">
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
    </div>
  )
}
