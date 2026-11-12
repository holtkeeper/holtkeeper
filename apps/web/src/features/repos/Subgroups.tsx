import { type ConfigEntryView, type RepoSummary, parentGroup } from '@holtkeeper/api'
import { Link, useNavigate } from '@tanstack/react-router'
import { FolderTree, Plus } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useGroupTitles, usePutGroup } from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import { MAX_GROUP_TITLE, groupPathTitle, validateGroupTitle } from '../../lib/group-titles.ts'
import { moveToSubgroup, subgroupDraft, validateGroupId } from '../../lib/repo.ts'
import { type GroupRow, groupHealthText, isExactPattern } from '../../lib/repos.ts'
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Notice,
  Select,
  Table,
  Tag,
  Td,
  TextField,
  Th,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

type GroupEntry = ConfigEntryView<'group'>

/**
 * A root group's Subgroups tab: its subgroups with their patterns and members' health, and, with
 * global `settings:write` and the parent's definition at hand, the New subgroup dialog.
 */
export function SubgroupsTab({
  row,
  definition,
  members,
}: {
  /** The parent's row of the group tree, holding its subgroups. */
  row: GroupRow | undefined
  definition: GroupEntry | undefined
  /** The parent's members the viewer can see, offered as exact paths. */
  members: readonly RepoSummary[]
}) {
  const { canGlobal } = useSession()
  const titleOf = useGroupTitles()
  const [creating, setCreating] = useState(false)
  const subgroups = row?.subgroups ?? []
  const writable = canGlobal('settings:write') && definition !== undefined

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted">
          A subgroup holds the members of this group its own patterns match. Grants, settings and
          knowledge on this group keep covering them; the subgroup's own entries win.
        </p>
        {writable ? (
          <Button variant="secondary" size="sm" onPress={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New subgroup
          </Button>
        ) : null}
      </div>
      {subgroups.length ? (
        <Table label="Subgroups">
          <thead>
            <tr>
              <Th>Subgroup</Th>
              <Th>Patterns</Th>
              <Th align="right">Repositories</Th>
              <Th>Health</Th>
            </tr>
          </thead>
          <tbody>
            {subgroups.map((sub) => {
              const health = groupHealthText(sub.counts)
              return (
                <tr key={sub.id}>
                  <Td>
                    <span className="flex flex-col gap-0.5">
                      <Link
                        to="/repos/groups/$groupId"
                        params={{ groupId: sub.id }}
                        className="font-medium hover:underline"
                      >
                        {titleOf(sub.id)}
                      </Link>
                      <span className="mono text-[11px] text-dim">{sub.id}</span>
                    </span>
                  </Td>
                  <Td>
                    {sub.include?.length ? (
                      <span className="flex flex-wrap gap-1">
                        {sub.include.slice(0, 3).map((pattern) => (
                          <Tag key={pattern} mono>
                            {pattern}
                          </Tag>
                        ))}
                        {sub.include.length > 3 ? (
                          <span className="text-xs text-muted">+{sub.include.length - 3}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </Td>
                  <Td align="right" className="tabular">
                    {sub.members.length}
                  </Td>
                  <Td>
                    {health.length ? (
                      <span className="text-xs text-muted">{health.join(' · ')}</span>
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      ) : (
        <EmptyState
          icon={<FolderTree />}
          title="No subgroups"
          description="Split the group's repositories by kind, e.g. services and libraries, to give each its own settings and knowledge."
        />
      )}
      {creating && definition ? (
        <NewSubgroupDialog
          parent={definition}
          members={members}
          taken={subgroups.map((sub) => sub.id)}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </div>
  )
}

function NewSubgroupDialog({
  parent,
  members,
  taken,
  onClose,
}: {
  parent: GroupEntry
  members: readonly RepoSummary[]
  /** Subgroup keys that exist already. */
  taken: readonly string[]
  onClose: () => void
}) {
  const titleOf = useGroupTitles()
  const navigate = useNavigate()
  const put = usePutGroup()
  const [title, setTitle] = useState('')
  const [suffix, setSuffix] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [glob, setGlob] = useState('')
  const sameForge = members.filter((m) => m.repo.forge === parent.data.forge)
  const paths = [...new Set(sameForge.map((m) => m.repo.path))].toSorted()
  const subgroupsOf = new Map(
    sameForge.map((m) => [
      m.repo.path,
      m.groups.filter((group) => parentGroup(group) === parent.id),
    ]),
  )
  const patterns = [...picked, ...(glob.trim() ? [glob.trim()] : [])]
  const draft = subgroupDraft(parent, suffix, title, patterns)
  const keyError = suffix
    ? suffix.includes('.')
      ? 'One level only: no dots in the key'
      : (validateGroupId(suffix) ??
        (taken.includes(draft.id) ? 'A subgroup with this key exists' : undefined))
    : undefined
  const globError =
    glob.trim() && isExactPattern(glob.trim()) && !paths.includes(glob.trim())
      ? 'Not a member of the parent; it would match nothing'
      : undefined
  const titleError = validateGroupTitle(title)
  const valid =
    suffix.trim() !== '' &&
    keyError === undefined &&
    titleError === undefined &&
    globError === undefined &&
    draft.data.include.length > 0

  const save = () =>
    put.mutate(draft, {
      onSuccess: () => {
        notify.success(
          'Subgroup created',
          `${groupPathTitle(titleOf, parent.id)} › ${draft.data.title ?? draft.id}`,
        )
        onClose()
        void navigate({ to: '/repos/groups/$groupId', params: { groupId: draft.id } })
      },
      onError: (error) => notify.error('Not created', messageOf(error)),
    })

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`New subgroup of ${titleOf(parent.id)}`}
      description={`On ${parent.data.forge}, like its parent. It holds the parent's members its patterns match.`}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isDisabled={!valid} isPending={put.isPending} onPress={save}>
            Create subgroup
          </Button>
        </>
      }
    >
      <TextField
        label="Display name"
        value={title}
        onChange={setTitle}
        placeholder="e.g. Services"
        description={`Up to ${MAX_GROUP_TITLE} characters; empty shows the key.`}
        error={titleError}
        autoFocus
      />
      <TextField
        label="Key"
        value={suffix}
        onChange={setSuffix}
        placeholder="services"
        mono
        description={`The subgroup's key is ${parent.id}.${suffix.trim() || '<key>'}; it never changes.`}
        error={keyError}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">
          Repositories of the parent <span className="tabular text-dim">{picked.length}</span>
        </span>
        {paths.length ? (
          <ul
            aria-label="Repositories of the parent"
            className="flex max-h-56 flex-col divide-y divide-line overflow-y-auto rounded-lg border border-line"
          >
            {paths.map((path) => (
              <li key={path} className="px-2.5 py-1.5">
                <Checkbox
                  label={
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="mono text-[12.5px]">{path}</span>
                      {(subgroupsOf.get(path) ?? []).map((group) => (
                        <Tag key={group}>{titleOf(group)}</Tag>
                      ))}
                    </span>
                  }
                  isSelected={picked.includes(path)}
                  onChange={(on) =>
                    setPicked((list) =>
                      on ? [...list, path] : list.filter((entry) => entry !== path),
                    )
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-muted">No members of the parent you can see.</span>
        )}
      </div>
      <TextField
        label="Glob"
        value={glob}
        onChange={setGlob}
        placeholder="team/service-*"
        mono
        description="Optional; matches the parent's members only. Picked repositories go in as exact paths."
        error={globError}
      />
    </Dialog>
  )
}

/**
 * Moves one repository into a subgroup: the target includes it and the subgroups it leaves drop
 * or exclude it. Needs global `settings:write`.
 */
export function MoveToSubgroupDialog({
  repo,
  from,
  targets,
  entries,
  onClose,
}: {
  repo: RepoSummary
  /** Subgroups it leaves. */
  from: readonly string[]
  /** Subgroups it can move to. */
  targets: readonly string[]
  entries: readonly GroupEntry[]
  onClose: () => void
}) {
  const titleOf = useGroupTitles()
  const put = usePutGroup()
  const [to, setTo] = useState<string>()
  const changes = to ? moveToSubgroup(entries, repo.repo.path, from, to) : []
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      for (const change of changes) {
        // oxlint-disable-next-line no-await-in-loop -- one group after another, target first
        await put.mutateAsync(change)
      }
      notify.success('Moved', `${repo.repo.path} → ${titleOf(to ?? '')}`)
      onClose()
    } catch (error) {
      notify.error('Not moved', messageOf(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title="Move to subgroup"
      description={<span className="mono">{repo.repo.path}</span>}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isDisabled={!to} isPending={saving} onPress={() => void save()}>
            Move
          </Button>
        </>
      }
    >
      <Select
        label="Subgroup"
        options={targets.map((id) => ({ id, label: titleOf(id), text: titleOf(id) }))}
        value={to}
        onChange={setTo}
        placeholder="Choose a subgroup"
      />
      {from.length ? (
        <Notice tone="accent" title={`Leaves ${plural(from.length, 'subgroup')}`}>
          {from.map(titleOf).join(', ')}: an exact path is dropped, a glob that matches it gets an
          exclude.
        </Notice>
      ) : null}
    </Dialog>
  )
}
