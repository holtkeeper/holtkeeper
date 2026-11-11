import type { Family, FamilySuggestion, RepoRef, RepoSummary } from '@holtkeeper/api'
import { Boxes, ChevronDown, ChevronRight, Globe, Pencil, Plus, Users } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useFamilyMutations, useFamilySuggestions } from '../../api/queries.ts'
import { type FamilyNode, type Space, buildSpaceTree, spaceKey } from '../../lib/guide.ts'
import { repoKey, repoName } from '../../lib/repo.ts'
import { Button, ScopeSwitch, Tooltip, notify } from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { FamilyDialog } from './FamilyDialog.tsx'

const itemClass = (current: boolean, depth: number) =>
  `flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] transition-colors ${
    depth === 0 ? 'pl-2' : depth === 1 ? 'pl-6' : 'pl-10'
  } ${current ? 'bg-raise text-foreground shadow-[0_0_0_1px_var(--line-strong)]' : 'text-muted hover:bg-raise hover:text-foreground'}`

/**
 * The Knowledge spaces: All, then teams with their families and repositories. The scope switch
 * folds other teams; family suggestions wait below for a person to confirm or dismiss them.
 */
export function SpacesSidebar({
  selected,
  onSelect,
  repos,
  families,
  canEditFamilies,
}: {
  selected: Space
  onSelect: (space: Space) => void
  repos: readonly RepoSummary[]
  families: readonly Family[]
  canEditFamilies: boolean
}) {
  const { view, setView, homeGroups } = useScope()
  const tree = buildSpaceTree(repos, families, view, homeGroups)
  const current = spaceKey(selected)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<{
    family?: Family
    initial?: { name: string; members: string[] }
  } | null>(null)
  const repoKeys = repos.map((r) => repoKey(r.repo))

  const toggle = (group: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })

  const repoItem = (repo: RepoRef, depth: number) => {
    const space: Space = { kind: 'repo', repo }
    return (
      <li key={`${depth}:${repoKey(repo)}`}>
        <button
          type="button"
          className={itemClass(current === spaceKey(space), depth)}
          aria-current={current === spaceKey(space) ? 'true' : undefined}
          title={repoKey(repo)}
          onClick={() => onSelect(space)}
        >
          <span className="mono truncate text-xs">{repoName(repo)}</span>
        </button>
      </li>
    )
  }

  const familyItem = (node: FamilyNode, depth: number, owner: string) => {
    const space: Space = { kind: 'family', family: node.family.id }
    const active = current === spaceKey(space)
    return (
      <li key={`${owner}:${node.family.id}`}>
        <div className="group flex items-center">
          <button
            type="button"
            className={itemClass(active, depth)}
            aria-current={active ? 'true' : undefined}
            onClick={() => onSelect(space)}
          >
            <Boxes className="size-3.5 shrink-0" />
            <span className="truncate">{node.family.name}</span>
            <span className="mono ml-auto text-[11px] text-dim">{node.family.members.length}</span>
          </button>
          {canEditFamilies ? (
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={`Edit family ${node.family.name}`}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onPress={() => setEditing({ family: node.family })}
            >
              <Pencil className="size-3" />
            </Button>
          ) : null}
        </div>
        <ul>{node.repos.map((repo) => repoItem(repo, depth + 1))}</ul>
      </li>
    )
  }

  return (
    <nav aria-label="Spaces" className="flex flex-col gap-3 text-sm">
      <button
        type="button"
        className={itemClass(current === 'all', 0)}
        aria-current={current === 'all' ? 'true' : undefined}
        onClick={() => onSelect({ kind: 'all' })}
      >
        <Globe className="size-3.5" />
        All repositories
      </button>

      <ScopeSwitch value={view} onChange={setView} counts={tree.counts} />

      <ul className="flex flex-col gap-0.5">
        {tree.teams.map((team) => {
          const space: Space = { kind: 'group', group: team.group }
          const open = !collapsed.has(team.group)
          return (
            <li key={team.group}>
              <div className="flex items-center">
                <button
                  type="button"
                  aria-label={open ? `Collapse ${team.group}` : `Expand ${team.group}`}
                  className="grid size-6 shrink-0 place-items-center text-dim hover:text-foreground"
                  onClick={() => toggle(team.group)}
                >
                  {open ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  className={itemClass(current === spaceKey(space), 0)}
                  aria-current={current === spaceKey(space) ? 'true' : undefined}
                  onClick={() => onSelect(space)}
                >
                  <Users className="size-3.5 shrink-0" />
                  <span className="truncate">{team.group}</span>
                </button>
              </div>
              {open ? (
                <ul>
                  {team.families.map((node) => familyItem(node, 1, team.group))}
                  {team.repos.map((repo) => repoItem(repo, 1))}
                </ul>
              ) : null}
            </li>
          )
        })}
        {tree.ungrouped.families.length || tree.ungrouped.repos.length ? (
          <li>
            <SidebarHeading>Not in a team</SidebarHeading>
            <ul>
              {tree.ungrouped.families.map((node) => familyItem(node, 0, '-'))}
              {tree.ungrouped.repos.map((repo) => repoItem(repo, 0))}
            </ul>
          </li>
        ) : null}
      </ul>
      {tree.folded ? (
        <button
          type="button"
          className="px-2 text-left text-xs text-dim hover:text-foreground"
          onClick={() => setView('all')}
        >
          {tree.folded} other {tree.folded === 1 ? 'team' : 'teams'} folded
        </button>
      ) : null}

      {canEditFamilies ? (
        <Suggestions onEdit={(initial) => setEditing({ initial })} onNew={() => setEditing({})} />
      ) : null}

      {editing ? (
        <FamilyDialog
          key={editing.family?.id ?? 'new'}
          {...(editing.family ? { family: editing.family } : {})}
          {...(editing.initial ? { initial: editing.initial } : {})}
          repos={repoKeys}
          onClose={() => setEditing(null)}
          onSaved={(family) => onSelect({ kind: 'family', family: family.id })}
        />
      ) : null}
    </nav>
  )
}

function SidebarHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between px-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-dim">{children}</span>
      {action}
    </div>
  )
}

function Suggestions({
  onEdit,
  onNew,
}: {
  onEdit: (initial: { name: string; members: string[] }) => void
  onNew: () => void
}) {
  const suggestions = useFamilySuggestions()
  const { create, dismiss } = useFamilyMutations()
  const open = suggestions.data?.suggestions ?? []

  const dismissOne = (suggestion: FamilySuggestion) =>
    dismiss.mutate(suggestion.members, {
      onError: (error) => notify.error('Not dismissed', messageOf(error)),
    })

  return (
    <section className="flex flex-col gap-1 border-t border-line pt-3">
      <SidebarHeading
        action={
          <Tooltip content="New family">
            <Button variant="ghost" size="sm" isIconOnly aria-label="New family" onPress={onNew}>
              <Plus className="size-3.5" />
            </Button>
          </Tooltip>
        }
      >
        Suggested families
      </SidebarHeading>
      {open.length === 0 ? (
        <p className="px-2 text-xs text-dim">
          {suggestions.isPending ? 'Looking for similar repositories…' : 'No suggestions.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {open.map((suggestion) => (
            <li
              key={suggestion.members.join(',')}
              className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel p-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12.5px] font-medium">{suggestion.name}</span>
                <span className="mono text-[11px] text-muted">
                  {Math.round(suggestion.similarity * 100)}%
                </span>
              </div>
              <span
                className="mono truncate text-[11px] text-muted"
                title={suggestion.members.join('\n')}
              >
                {suggestion.members.length} repos
                {suggestion.framework ? ` · ${suggestion.framework}` : ''}
                {suggestion.toolchain.length ? ` · ${suggestion.toolchain.join(', ')}` : ''}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  isPending={create.isPending}
                  onPress={() =>
                    create.mutate(
                      { name: suggestion.name, members: suggestion.members },
                      {
                        onSuccess: (family) => notify.success('Family confirmed', family.name),
                        onError: (error) => notify.error('Not confirmed', messageOf(error)),
                      },
                    )
                  }
                >
                  Confirm
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => onEdit({ name: suggestion.name, members: suggestion.members })}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  isPending={dismiss.isPending && dismiss.variables === suggestion.members}
                  onPress={() => dismissOne(suggestion)}
                >
                  Dismiss
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
