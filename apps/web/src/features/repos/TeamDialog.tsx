import type { ConfigEntryView, RepoSummary, TeamRole } from '@holtkeeper/api'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { usePutTeam } from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import {
  type TeamDraft,
  type TeamEditLevel,
  ownershipChange,
  ownershipChangeText,
  toTeamDraft,
  toTeamInput,
} from '../../lib/repos.ts'
import { validateRootedPattern } from '../../lib/scope.ts'
import { validateTeamKey, validateTeamTitle } from '../../lib/team-titles.ts'
import { Button, Dialog, Notice, Select, TagInput, TextField, notify } from '../../ui/index.ts'

const roles: readonly { id: TeamRole; label: string }[] = [
  { id: 'maintainer', label: 'Maintainer' },
  { id: 'member', label: 'Member' },
]

/**
 * Creates or edits a team. `level` decides the fields: `full` (global `settings:write`) edits the
 * key of a new team and its `owns`, `exclude` and `consumes` patterns with a live preview of the
 * repositories it gains and loses; `members` (a maintainer) edits only the title and the members.
 */
export function TeamDialog({
  entry,
  level,
  repos,
  onClose,
}: {
  /** The stored team; absent for a new one. */
  entry?: ConfigEntryView<'team'>
  level: Exclude<TeamEditLevel, 'none'>
  /** Visible repositories, for the ownership preview. */
  repos: readonly RepoSummary[]
  onClose: () => void
}) {
  const isNew = entry === undefined
  const [draft, setDraft] = useState<TeamDraft>(() => toTeamDraft(entry?.id, entry?.data))
  const [submitted, setSubmitted] = useState(false)
  const put = usePutTeam()
  const full = level === 'full'
  const set = (patch: Partial<TeamDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const change = ownershipChange(repos, entry?.data, draft)
  const changeText = ownershipChangeText(change)
  const keyError = isNew ? validateTeamKey(draft.id) : undefined
  const titleError = validateTeamTitle(draft.title)
  const ownsError = full && draft.owns.length === 0 ? 'Add at least one pattern' : undefined
  const invalid = Boolean(keyError || titleError || ownsError)

  const save = () => {
    setSubmitted(true)
    if (invalid) return
    put.mutate(
      { id: draft.id.trim(), data: toTeamInput(draft) },
      {
        onSuccess: () => {
          notify.success(isNew ? 'Team created' : 'Team saved', draft.title || draft.id)
          onClose()
        },
        onError: (error) => notify.error('Team not saved', messageOf(error)),
      },
    )
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={isNew ? 'New team' : `Edit ${entry.data.title ?? entry.id}`}
      description={
        full
          ? 'A team owns the repositories its patterns match; grants, settings and knowledge can name it.'
          : 'As a maintainer you change the title and the members; patterns need an admin.'
      }
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isPending={put.isPending} onPress={save}>
            {isNew ? 'Create team' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Key"
          value={draft.id}
          onChange={(id) => set({ id })}
          isDisabled={!isNew}
          mono
          placeholder="e.g. widgets"
          description={isNew ? 'Used in scopes and URLs; cannot change later.' : undefined}
          error={submitted ? keyError : undefined}
        />
        <TextField
          label="Title"
          value={draft.title}
          onChange={(title) => set({ title })}
          placeholder="e.g. Widgets"
          error={submitted ? titleError : undefined}
        />
      </div>
      {full ? (
        <>
          <TagInput
            label="Owns"
            values={draft.owns}
            onChange={(owns) => set({ owns })}
            placeholder="e.g. acme/round/**"
            validate={validateRootedPattern}
            description={
              submitted && ownsError ? (
                <span className="text-danger">{ownsError}</span>
              ) : (
                `Path patterns, optionally with a forge: work:acme/round/**. Matches ${plural(change.owned.length, 'visible repository', 'visible repositories')}.`
              )
            }
          />
          <TagInput
            label="Exclude"
            values={draft.exclude}
            onChange={(exclude) => set({ exclude })}
            placeholder="e.g. acme/round/legacy-*"
            validate={validateRootedPattern}
            description="Repositories these match are not owned even when Owns matches them."
          />
          <TagInput
            label="Consumes"
            values={draft.consumes}
            onChange={(consumes) => set({ consumes })}
            placeholder="e.g. acme/shared/**"
            validate={validateRootedPattern}
            description="Repositories the team depends on without owning them; they show as context."
          />
          {changeText && !isNew ? (
            <Notice tone="accent" title={`Unsaved: ${changeText}`}>
              {[...change.joins, ...change.leaves]
                .slice(0, 6)
                .map((r) => `${change.joins.includes(r) ? '+' : '−'} ${r.repo.path}`)
                .join(' · ')}
            </Notice>
          ) : null}
        </>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Members</legend>
        {draft.members.length === 0 ? <p className="text-xs text-muted">No members yet.</p> : null}
        {draft.members.map((member, index) => (
          <div key={index} className="flex items-end gap-2">
            <TextField
              aria-label={`Member ${index + 1}`}
              value={member.id}
              onChange={(id) =>
                set({ members: draft.members.map((m, i) => (i === index ? { ...m, id } : m)) })
              }
              placeholder="User id or e-mail"
              mono
              className="flex-1"
            />
            <Select
              aria-label={`Role of member ${index + 1}`}
              className="w-36"
              options={roles}
              value={member.role}
              onChange={(role) =>
                set({
                  members: draft.members.map((m, i) =>
                    i === index
                      ? { ...m, role: role === 'maintainer' ? 'maintainer' : 'member' }
                      : m,
                  ),
                })
              }
            />
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={`Remove member ${member.id || index + 1}`}
              onPress={() => set({ members: draft.members.filter((_, i) => i !== index) })}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => set({ members: [...draft.members, { id: '', role: 'member' }] })}
          >
            <Plus className="size-3.5" />
            Add member
          </Button>
        </div>
        <p className="text-xs text-muted">
          Maintainers may edit this team&apos;s title and members and act on its repositories.
        </p>
      </fieldset>
    </Dialog>
  )
}
