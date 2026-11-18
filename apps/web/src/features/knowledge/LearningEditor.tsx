import type { LearningView, Scope } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useLearningMutations } from '../../api/queries.ts'
import {
  type LearningDraft,
  emptyLearningDraft,
  learningCreateOf,
  learningDraftOf,
  learningDraftProblems,
  learningPatchOf,
} from '../../lib/learnings.ts'
import { ruleAgents, validateFileGlob } from '../../lib/rules.ts'
import { Button, MultiToggle, Notice, TagInput, TextField, notify } from '../../ui/index.ts'
import { ScopeEditor } from '../access/ScopeEditor.tsx'

/**
 * Writes a new learning (active at once; a text the fleet already has reinforces that learning
 * instead) or edits one: text, reason, scope, files and agents.
 */
export function LearningEditor({
  learning,
  initialScope,
  onSaved,
  onCancel,
}: {
  learning?: LearningView
  initialScope?: Scope
  onSaved: (learning: LearningView) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<LearningDraft>(() =>
    learning ? learningDraftOf(learning) : emptyLearningDraft(initialScope),
  )
  const { create, edit } = useLearningMutations()
  const problems = learningDraftProblems(draft)
  const error = create.error ?? edit.error
  const set = (patch: Partial<LearningDraft>) => setDraft((previous) => ({ ...previous, ...patch }))

  const save = () => {
    if (!learning)
      return create.mutate(learningCreateOf(draft), {
        onSuccess: (result) => {
          notify.success(
            result.status === 'merged' ? 'Merged into an existing learning' : 'Learning added',
            result.learning.text,
          )
          onSaved(result.learning)
        },
      })
    edit.mutate(
      { id: learning.id, input: learningPatchOf(draft) },
      {
        onSuccess: (saved) => {
          notify.success('Learning saved', saved.text)
          onSaved(saved)
        },
      },
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Notice tone="danger" title="Not saved">
          {messageOf(error)}
        </Notice>
      ) : null}
      <TextField
        label="Learning"
        value={draft.text}
        onChange={(text) => set({ text })}
        placeholder="e.g. Snapshot tests need a fixed seed."
        description="One imperative sentence, without names."
        multiline
        rows={2}
        autoFocus
      />
      <TextField
        label="Reason"
        value={draft.reason}
        onChange={(reason) => set({ reason })}
        placeholder="Why it holds, when it is not obvious"
        multiline
        rows={2}
      />
      <ScopeEditor value={draft.scope} onChange={(scope) => set({ scope })} label="Scope" />
      <TagInput
        label="Files"
        values={draft.files}
        onChange={(files) => set({ files })}
        placeholder="e.g. **/*.test.tsx"
        validate={validateFileGlob}
        description="Optional. Path globs the learning is about; empty means the whole repository."
      />
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Agents</span>
        <MultiToggle
          aria-label="Agents"
          options={ruleAgents}
          value={draft.agents}
          onChange={(agents) => set({ agents })}
        />
        <span className="text-xs text-muted">None picked means every agent run reads it.</span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {problems.length ? (
          <p className="mr-auto text-xs text-muted">
            To save: {problems.join(' · ').toLowerCase()}
          </p>
        ) : null}
        <Button variant="tertiary" size="sm" onPress={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onPress={save}
          isDisabled={problems.length > 0}
          isPending={create.isPending || edit.isPending}
        >
          Save
        </Button>
      </div>
    </div>
  )
}
