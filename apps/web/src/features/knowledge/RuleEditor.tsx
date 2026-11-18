import type { RuleView, Scope } from '@holtkeeper/api'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useRuleMutations } from '../../api/queries.ts'
import {
  type RuleDraft,
  emptyRuleDraft,
  isVersionConflict,
  ruleAgents,
  ruleDraftOf,
  ruleDraftProblems,
  ruleInputOf,
  validateFileGlob,
} from '../../lib/rules.ts'
import { Button, MultiToggle, Notice, Switch, TagInput, TextField, notify } from '../../ui/index.ts'
import { ScopeEditor } from '../access/ScopeEditor.tsx'
import { MarkdownEditor } from './parts.tsx'

/**
 * Creates a rule or edits one. Saving an edit sends the version the editor started from; when
 * someone saved the rule in the meantime the server refuses it and the editor says to reload.
 */
export function RuleEditor({
  rule,
  initialScope,
  onSaved,
  onCancel,
  onReload,
}: {
  rule?: RuleView
  initialScope?: Scope
  onSaved: (rule: RuleView) => void
  onCancel: () => void
  /** Drops the edits and reopens the editor on the stored rule after a version conflict. */
  onReload?: () => void
}) {
  const [draft, setDraft] = useState<RuleDraft>(() =>
    rule ? ruleDraftOf(rule) : emptyRuleDraft(initialScope),
  )
  const { create, update } = useRuleMutations()
  const problems = ruleDraftProblems(draft)
  const pending = create.isPending || update.isPending
  const error = create.error ?? update.error
  const conflict = isVersionConflict(error)
  const set = (patch: Partial<RuleDraft>) => setDraft((previous) => ({ ...previous, ...patch }))

  const save = () => {
    const done = (saved: RuleView) => {
      notify.success(rule ? 'Rule saved' : 'Rule added', saved.title)
      onSaved(saved)
    }
    if (!rule) return create.mutate(ruleInputOf(draft), { onSuccess: done })
    update.mutate({ id: rule.id, input: ruleInputOf(draft, rule.version) }, { onSuccess: done })
  }

  return (
    <div className="flex flex-col gap-4">
      {conflict ? (
        <Notice tone="warning" title="Someone saved this rule in the meantime">
          <div className="flex flex-col items-start gap-2">
            <span>Reload it, merge your edits and save again. Reloading drops your edits.</span>
            {onReload ? (
              <Button size="sm" variant="secondary" onPress={onReload}>
                Reload
              </Button>
            ) : null}
          </div>
        </Notice>
      ) : error ? (
        <Notice tone="danger" title="Not saved">
          {messageOf(error)}
        </Notice>
      ) : null}
      <TextField
        label="Title"
        value={draft.title}
        onChange={(title) => set({ title })}
        placeholder="e.g. Contract tests for API routes"
        autoFocus
      />
      <MarkdownEditor
        label="Rule"
        value={draft.body}
        onChange={(body) => set({ body })}
        description="Markdown. Short imperative lines an agent can follow; say why when it is not obvious."
      />
      <ScopeEditor value={draft.scope} onChange={(scope) => set({ scope })} label="Scope" />
      <TagInput
        label="Files"
        values={draft.files}
        onChange={(files) => set({ files })}
        placeholder="e.g. src/routes/**"
        validate={validateFileGlob}
        description="Optional. The rule applies only when the run touches a matching file."
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
      <TextField
        label="Description"
        value={draft.description}
        onChange={(description) => set({ description })}
        placeholder="Only for rules agents ask for"
        description="A rule with only a description is not injected: agents see it listed and read it when it fits."
      />
      <Switch
        label="Always apply"
        isSelected={draft.alwaysApply}
        isDisabled={!draft.description.trim()}
        onChange={(alwaysApply) => set({ alwaysApply })}
        description="Keeps a rule with a description injected."
      />
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
          isDisabled={problems.length > 0 || conflict}
          isPending={pending}
        >
          Save
        </Button>
      </div>
    </div>
  )
}
