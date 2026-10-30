import type { KnowledgeEntry, Scope } from '@holtkeeper/api'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useKnowledgeMutations } from '../../api/queries.ts'
import {
  type KnowledgeDraft,
  draftOf,
  draftProblems,
  emptyDraft,
  inputOf,
  isKnowledgeKind,
  knowledgeKinds,
  taskKinds,
} from '../../lib/knowledge.ts'
import {
  Button,
  Dialog,
  Markdown,
  MultiToggle,
  Notice,
  Select,
  TagInput,
  TextField,
  notify,
} from '../../ui/index.ts'
import { ScopeEditor } from '../access/ScopeEditor.tsx'

/** Creates a knowledge entry, or edits one (accepting a proposal with the edits when asked). */
export function KnowledgeDialog({
  entry,
  initialScope,
  groups,
  onClose,
}: {
  entry?: KnowledgeEntry
  /** Scope of a new entry; defaults to everything. */
  initialScope?: Scope
  groups: readonly string[]
  onClose: () => void
}) {
  const [draft, setDraft] = useState<KnowledgeDraft>(() =>
    entry ? draftOf(entry) : emptyDraft(initialScope),
  )
  const { create, update, review } = useKnowledgeMutations()
  const problems = draftProblems(draft)
  const pending = create.isPending || update.isPending || review.isPending
  const error = create.error ?? update.error ?? review.error
  const set = (patch: Partial<KnowledgeDraft>) =>
    setDraft((previous) => ({ ...previous, ...patch }))

  const save = (accept: boolean) => {
    const input = inputOf(draft)
    const done = () => {
      notify.success(accept ? 'Entry accepted' : entry ? 'Entry saved' : 'Entry added', input.title)
      onClose()
    }
    if (!entry) return create.mutate(input, { onSuccess: done })
    update.mutate(
      { id: entry.id, input },
      {
        onSuccess: (saved) =>
          accept ? review.mutate({ id: saved.id, action: 'accept' }, { onSuccess: done }) : done(),
      },
    )
  }

  const kind = knowledgeKinds.find((k) => k.id === draft.kind)
  const isProposal = entry?.status === 'proposed'

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      size="xl"
      title={entry ? (isProposal ? 'Review proposal' : 'Edit entry') : 'New knowledge entry'}
      description={
        entry?.source === 'agent'
          ? `Proposed by ${entry.author}. Agents only read accepted entries.`
          : 'Agents read accepted entries for repositories in scope and can cite them.'
      }
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          {isProposal ? (
            <Button
              variant="secondary"
              onPress={() => save(false)}
              isDisabled={problems.length > 0}
              isPending={pending}
            >
              Save as proposal
            </Button>
          ) : null}
          <Button
            variant="primary"
            onPress={() => save(isProposal)}
            isDisabled={problems.length > 0}
            isPending={pending}
          >
            {isProposal ? 'Save and accept' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {error ? (
            <Notice tone="danger" title="Not saved">
              {messageOf(error)}
            </Notice>
          ) : null}
          <TextField
            label="Title"
            value={draft.title}
            onChange={(title) => set({ title })}
            placeholder="e.g. Money is stored in minor units"
            autoFocus
          />
          <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <Select
              label="Kind"
              options={knowledgeKinds.map((k) => ({ id: k.id, label: k.label }))}
              value={draft.kind}
              onChange={(id) => isKnowledgeKind(id) && set({ kind: id })}
            />
            <p className="self-end pb-2 text-xs text-muted">{kind?.hint}</p>
          </div>
          <TextField
            label="Explanation"
            value={draft.body}
            onChange={(body) => set({ body })}
            multiline
            rows={8}
            description="Markdown. Say what to do and why; agents follow it literally."
          />
          <ScopeEditor
            value={draft.scope}
            onChange={(scope) => set({ scope })}
            groups={groups}
            label="Applies to repositories"
          />
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Used by tasks</span>
            <MultiToggle
              aria-label="Task kinds"
              options={taskKinds}
              value={draft.appliesTo}
              onChange={(next) => {
                const added = next.find((id) => !draft.appliesTo.includes(id))
                set({
                  appliesTo: added === '*' ? ['*'] : added ? next.filter((id) => id !== '*') : next,
                })
              }}
            />
          </div>
          <TagInput
            label="Topics"
            values={draft.topics}
            onChange={(topics) => set({ topics })}
            placeholder="e.g. testing"
          />
          <PackagesEditor draft={draft} onChange={(packages) => set({ packages })} />
          <EvidenceEditor draft={draft} onChange={(evidence) => set({ evidence })} />
          {problems.length ? (
            <p className="text-xs text-muted">To save: {problems.join(' · ').toLowerCase()}</p>
          ) : null}
        </div>
        <aside className="flex flex-col gap-3 rounded-2xl bg-default/60 p-4 lg:sticky lg:top-0 lg:self-start">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Preview</span>
          <span className="font-medium">{draft.title || 'Untitled'}</span>
          {draft.body.trim() ? (
            <Markdown text={draft.body} className="text-sm" />
          ) : (
            <span className="text-sm text-muted">The explanation shows here.</span>
          )}
        </aside>
      </div>
    </Dialog>
  )
}

function PackagesEditor({
  draft,
  onChange,
}: {
  draft: KnowledgeDraft
  onChange: (packages: KnowledgeDraft['packages']) => void
}) {
  const rows = draft.packages
  const edit = (index: number, patch: Partial<KnowledgeDraft['packages'][number]>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">
        Packages{draft.kind === 'migration' ? '' : ' (optional)'}
      </legend>
      {rows.map((row, index) => (
        // oxlint-disable-next-line react/no-array-index-key
        <div key={index} className="grid grid-cols-[6rem_minmax(0,1fr)_7rem_7rem_auto] gap-2">
          <TextField
            label="Ecosystem"
            value={row.ecosystem}
            onChange={(ecosystem) => edit(index, { ecosystem })}
            placeholder="npm"
            mono
          />
          <TextField
            label="Name"
            value={row.name}
            onChange={(name) => edit(index, { name })}
            placeholder="react"
            mono
          />
          <TextField
            label="From"
            value={row.from ?? ''}
            onChange={(from) => edit(index, { from })}
            placeholder=">=18 <19"
            mono
          />
          <TextField
            label="To"
            value={row.to ?? ''}
            onChange={(to) => edit(index, { to })}
            placeholder=">=19"
            mono
          />
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="Remove package"
            className="self-end"
            onPress={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onPress={() => onChange([...rows, { ecosystem: 'npm', name: '' }])}
      >
        <Plus className="size-3.5" />
        Add package
      </Button>
    </fieldset>
  )
}

function EvidenceEditor({
  draft,
  onChange,
}: {
  draft: KnowledgeDraft
  onChange: (evidence: KnowledgeDraft['evidence']) => void
}) {
  const rows = draft.evidence
  const edit = (index: number, patch: Partial<KnowledgeDraft['evidence'][number]>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">Evidence (optional)</legend>
      {rows.map((row, index) => (
        // oxlint-disable-next-line react/no-array-index-key
        <div key={index} className="grid grid-cols-[10rem_minmax(0,1fr)_auto] gap-2">
          <TextField
            label="Label"
            value={row.label}
            onChange={(label) => edit(index, { label })}
            placeholder="MR !42"
          />
          <TextField
            label="URL"
            type="url"
            value={row.url}
            onChange={(url) => edit(index, { url })}
            placeholder="https://"
          />
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="Remove link"
            className="self-end"
            onPress={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onPress={() => onChange([...rows, { label: '', url: '' }])}
      >
        <Plus className="size-3.5" />
        Add link
      </Button>
    </fieldset>
  )
}
