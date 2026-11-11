import type { Family } from '@holtkeeper/api'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useFamilyMutations } from '../../api/queries.ts'
import { familyProblems } from '../../lib/guide.ts'
import { Button, Dialog, Notice, TagInput, TextField, notify } from '../../ui/index.ts'

/** Creates a family of similar repositories, or renames, regroups or deletes one. */
export function FamilyDialog({
  family,
  initial,
  repos,
  onClose,
  onSaved,
}: {
  family?: Family
  /** Name and members a new family starts with, e.g. from a suggestion. */
  initial?: { name: string; members: string[] }
  /** Known repositories as `forge:path`. */
  repos: readonly string[]
  onClose: () => void
  onSaved?: (family: Family) => void
}) {
  const [name, setName] = useState(family?.name ?? initial?.name ?? '')
  const [members, setMembers] = useState<string[]>(family?.members ?? initial?.members ?? [])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { create, update, remove } = useFamilyMutations()
  const known = new Set(repos)
  const problems = familyProblems({ name, members }, known)
  const error = create.error ?? update.error ?? remove.error
  const input = { name: name.trim(), members: [...new Set(members)].toSorted() }

  const done = (saved: Family) => {
    notify.success(family ? 'Family saved' : 'Family created', saved.name)
    onSaved?.(saved)
    onClose()
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={family ? `Family ${family.name}` : 'New family'}
      description="Similar repositories that share rules, e.g. near-identical app frontends. A repository belongs to one family at most."
      footer={
        <>
          {family ? (
            <Button
              variant={confirmDelete ? 'danger' : 'ghost'}
              isPending={remove.isPending}
              onPress={() =>
                confirmDelete
                  ? remove.mutate(family.id, {
                      onSuccess: () => {
                        notify.success('Family deleted', family.name)
                        onClose()
                      },
                    })
                  : setConfirmDelete(true)
              }
            >
              <Trash2 className="size-3.5" />
              {confirmDelete ? 'Delete with its rules' : 'Delete'}
            </Button>
          ) : null}
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={problems.length > 0}
            isPending={create.isPending || update.isPending}
            onPress={() =>
              family
                ? update.mutate({ id: family.id, input }, { onSuccess: done })
                : create.mutate(input, { onSuccess: done })
            }
          >
            Save
          </Button>
        </>
      }
    >
      {error ? (
        <Notice tone="danger" title="Not saved">
          {messageOf(error)}
        </Notice>
      ) : null}
      <TextField label="Name" value={name} onChange={setName} placeholder="e.g. Widget apps" />
      <TagInput
        label="Repositories"
        values={members}
        onChange={setMembers}
        suggestions={repos.filter((repo) => !members.includes(repo))}
        validate={(value) => (known.has(value) ? undefined : 'Pick a known repository')}
        placeholder="forge:group/repo"
      />
      {problems.length ? (
        <p className="text-xs text-muted">To save: {problems.join(' · ').toLowerCase()}</p>
      ) : null}
    </Dialog>
  )
}
