import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useForges, useGroups, usePutGroup } from '../../api/queries.ts'
import { validateGroupId, validateRepoPath, withRepo } from '../../lib/repo.ts'
import { Button, Dialog, Notice, Segmented, Select, TextField, notify } from '../../ui/index.ts'

/**
 * Adds a repository by including its exact path in a group of the panel config, an existing one or
 * a new one. The group decides which settings, schedules and access apply to it.
 */
export function AddRepoDialog({ onClose }: { onClose: () => void }) {
  const forges = useForges()
  const groups = useGroups()
  const put = usePutGroup()
  const forgeIds = (forges.data?.entries ?? []).map((entry) => entry.id)
  const [forge, setForge] = useState<string | undefined>()
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [groupId, setGroupId] = useState<string | undefined>()
  const [newGroup, setNewGroup] = useState('')

  const selectedForge = forge ?? (forgeIds.length === 1 ? forgeIds[0] : undefined)
  const forgeGroups = (groups.data?.entries ?? []).filter(
    (entry) => entry.data.forge === selectedForge,
  )
  const groupMode = forgeGroups.length ? mode : 'new'
  const target = groupMode === 'existing' ? groupId : newGroup.trim()
  const existing = forgeGroups.find((entry) => entry.id === target)
  const pathError = path ? validateRepoPath(path) : undefined
  const groupError =
    groupMode === 'new' && newGroup
      ? (validateGroupId(newGroup) ??
        ((groups.data?.entries ?? []).some((entry) => entry.id === newGroup.trim())
          ? 'A group with this id exists'
          : undefined))
      : undefined
  const invalid =
    !selectedForge || !target || validateRepoPath(path) !== undefined || groupError !== undefined

  const save = () => {
    if (!selectedForge || !target) return
    const repoPath = path.trim()
    put.mutate(
      { id: target, data: withRepo(existing?.data, selectedForge, repoPath) },
      {
        onSuccess: () => {
          notify.success('Repository added', `${selectedForge}:${repoPath} in group ${target}`)
          onClose()
        },
      },
    )
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title="Add repository"
      description="Holtkeeper works on repositories through groups: settings, schedules and access follow the group."
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onPress={save} isDisabled={invalid} isPending={put.isPending}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {forges.isError || groups.isError ? (
          <Notice tone="danger" title="Config is not available">
            {messageOf(forges.error ?? groups.error)}
          </Notice>
        ) : null}
        {put.error ? (
          <Notice tone="danger" title="Not added">
            {messageOf(put.error)}
          </Notice>
        ) : null}
        {forges.isSuccess && forgeIds.length === 0 ? (
          <Notice tone="warning" title="No forge configured">
            Add a GitLab or GitHub forge to the config first.
          </Notice>
        ) : null}
        <Select
          label="Forge"
          options={forgeIds.map((id) => ({ id, label: id }))}
          value={selectedForge}
          onChange={setForge}
          placeholder="Choose a forge"
        />
        <TextField
          label="Path"
          value={path}
          onChange={setPath}
          placeholder="team/app"
          mono
          error={pathError}
          description="As in the forge URL, without the host"
          autoFocus
        />
        {forgeGroups.length ? (
          <Segmented
            aria-label="Group"
            options={[
              { id: 'existing', label: 'Existing group' },
              { id: 'new', label: 'New group' },
            ]}
            value={mode}
            onChange={setMode}
          />
        ) : null}
        {groupMode === 'existing' ? (
          <Select
            label="Group"
            options={forgeGroups.map((entry) => ({
              id: entry.id,
              label: (
                <span className="flex items-baseline gap-2">
                  {entry.id}
                  <span className="truncate font-mono text-[11px] text-muted">
                    {entry.data.include.join(', ')}
                  </span>
                </span>
              ),
              text: entry.id,
            }))}
            value={groupId}
            onChange={setGroupId}
            placeholder="Choose a group"
          />
        ) : (
          <TextField
            label="New group id"
            value={newGroup}
            onChange={setNewGroup}
            placeholder="e.g. payments"
            mono
            error={groupError}
          />
        )}
        {existing?.provenance === 'file' ? (
          <p className="text-xs text-muted">
            This group comes from the config file; saving it here makes a panel copy that replaces
            the file entry.
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
