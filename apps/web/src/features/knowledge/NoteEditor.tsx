import type { KnowledgeEntry, Scope } from '@holtkeeper/api'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
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
  isVisibility,
  knowledgeKinds,
  taskKinds,
  visibilityOptions,
} from '../../lib/knowledge.ts'
import { Button, MultiToggle, Notice, Select, TagInput, TextField, notify } from '../../ui/index.ts'
import { ScopeEditor } from '../access/ScopeEditor.tsx'
import { MarkdownEditor } from './parts.tsx'

/**
 * Creates a note or edits one in place (accepting a proposal with the edits when asked). Title
 * and text are always visible; scope, tasks, topics, packages and evidence sit under Details.
 */
export function NoteEditor({
  entry,
  initialScope,
  groups,
  onClose,
}: {
  entry?: KnowledgeEntry
  /** Scope of a new note; defaults to everything. */
  initialScope?: Scope
  groups: readonly string[]
  onClose: () => void
}) {
  const [draft, setDraft] = useState<KnowledgeDraft>(() =>
    entry ? draftOf(entry) : emptyDraft(initialScope),
  )
  const [details, setDetails] = useState(!entry)
  const { create, update, review } = useKnowledgeMutations()
  const problems = draftProblems(draft)
  const pending = create.isPending || update.isPending || review.isPending
  const error = create.error ?? update.error ?? review.error
  const set = (patch: Partial<KnowledgeDraft>) =>
    setDraft((previous) => ({ ...previous, ...patch }))

  const save = (accept: boolean) => {
    const input = inputOf(draft)
    const done = () => {
      notify.success(accept ? 'Note accepted' : entry ? 'Note saved' : 'Note added', input.title)
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
    <div className="flex flex-col gap-3 rounded-2xl border border-line-strong bg-panel p-4">
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
      <MarkdownEditor
        label="Explanation"
        value={draft.body}
        onChange={(body) => set({ body })}
        description="Markdown. Say what to do and why; agents follow it literally."
      />
      <button
        type="button"
        className="inline-flex items-center gap-1 self-start text-xs font-medium text-muted hover:text-foreground"
        aria-expanded={details}
        onClick={() => setDetails((open) => !open)}
      >
        {details ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Details
      </button>
      {details ? (
        <div className="flex flex-col gap-4 border-l border-line pl-4">
          <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <Select
              label="Kind"
              options={knowledgeKinds.map((k) => ({ id: k.id, label: k.label }))}
              value={draft.kind}
              onChange={(id) => isKnowledgeKind(id) && set({ kind: id })}
            />
            <p className="self-end pb-2 text-xs text-muted">{kind?.hint}</p>
          </div>
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
          <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <Select
              label="Visible to"
              options={visibilityOptions.map((option) => ({ id: option.id, label: option.label }))}
              value={draft.visibility}
              onChange={(id) => isVisibility(id) && set({ visibility: id })}
            />
            <TextField
              label="Subject"
              value={draft.subject}
              onChange={(subject) => set({ subject })}
              placeholder="e.g. npm:date-fns or tool:node"
              description={visibilityOptions.find((option) => option.id === draft.visibility)?.hint}
            />
          </div>
          <EvidenceEditor draft={draft} onChange={(evidence) => set({ evidence })} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {problems.length ? (
          <p className="mr-auto text-xs text-muted">
            To save: {problems.join(' · ').toLowerCase()}
          </p>
        ) : null}
        <Button variant="tertiary" size="sm" onPress={onClose}>
          Cancel
        </Button>
        {isProposal ? (
          <Button
            variant="secondary"
            size="sm"
            onPress={() => save(false)}
            isDisabled={problems.length > 0}
            isPending={pending}
          >
            Save as proposal
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          onPress={() => save(isProposal)}
          isDisabled={problems.length > 0}
          isPending={pending}
        >
          {isProposal ? 'Save and accept' : 'Save'}
        </Button>
      </div>
    </div>
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
