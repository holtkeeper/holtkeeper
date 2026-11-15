import type {
  Family,
  FamilySuggestion,
  KnowledgeCounts,
  RepoRef,
  RepoSummary,
} from '@holtkeeper/api'
import { Boxes, ChevronDown, ChevronRight, Folder, Globe, Pencil, Plus, Users } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useFamilyMutations, useFamilySuggestions } from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import {
  type FamilyNode,
  type Space,
  type TeamNode,
  buildSpaceTree,
  foldList,
  spaceCounts,
  spaceKey,
} from '../../lib/guide.ts'
import { repoKey, repoName } from '../../lib/repo.ts'
import { type FolderNode, folderKey } from '../../lib/repos.ts'
import {
  Button,
  Count,
  TeamName,
  NoTeamsState,
  notify,
  ScopeSwitch,
  Tooltip,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { FamilyDialog, similarityText } from './FamilyDialog.tsx'

const itemClass = (current: boolean, depth: number) =>
  `flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] transition-colors ${
    depth < 0
      ? 'pl-0'
      : depth === 0
        ? 'pl-2'
        : depth === 1
          ? 'pl-6'
          : depth === 2
            ? 'pl-10'
            : 'pl-14'
  } ${current ? 'bg-raise text-foreground shadow-[0_0_0_1px_var(--line-strong)]' : 'text-muted hover:bg-raise hover:text-foreground'}`

/** How many families and repositories a team lists before "N more". */
const TEAM_LIMIT = 5

/** Guide sections and notes of a space as a quiet number, learnings waiting as a warning badge. */
function SpaceBadge({ counts, space }: { counts: KnowledgeCounts | undefined; space: Space }) {
  const { guide, notes, learnings } = spaceCounts(counts, space)
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {learnings ? (
        <Count tone="warning" label={plural(learnings, 'learning') + ' waiting'}>
          {learnings}
        </Count>
      ) : null}
      {guide + notes ? (
        <span
          className="mono text-[11px] text-dim"
          title={`${plural(guide, 'Guide section')}, ${plural(notes, 'note')}`}
        >
          {guide + notes}
        </span>
      ) : null}
    </span>
  )
}

const toggled = (previous: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(previous)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/**
 * The Knowledge spaces: All, then teams with their families and repositories, each with its
 * Knowledge counts; a repository shows under every team owning it. Long teams fold behind
 * "N more"; under *My teams* other teams fold into one collapsed row. Folders of the repositories
 * in scope follow as a collapsible tree. Family suggestions wait below for a person to confirm or
 * dismiss them.
 */

const MEMBERS_SHOWN = 4

const repoPathOf = (member: string): string => member.slice(member.indexOf(':') + 1)

export function SpacesSidebar({
  selected,
  onSelect,
  repos,
  families,
  counts,
  canEditFamilies,
}: {
  selected: Space
  onSelect: (space: Space) => void
  repos: readonly RepoSummary[]
  families: readonly Family[]
  counts: KnowledgeCounts | undefined
  canEditFamilies: boolean
}) {
  const { view, setView, homeTeams, noTeams } = useScope()
  const tree = buildSpaceTree(repos, families, view, homeTeams)
  const current = spaceKey(selected)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [othersOpen, setOthersOpen] = useState(false)
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<{
    family?: Family
    initial?: FamilySuggestion
  } | null>(null)
  const repoKeys = repos.map((r) => repoKey(r.repo))

  const toggle = (team: string) => setCollapsed((previous) => toggled(previous, team))
  const expand = (team: string) => setExpanded((previous) => toggled(previous, team))

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
          <SpaceBadge counts={counts} space={space} />
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
            <SpaceBadge counts={counts} space={space} />
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

  const teamItem = (team: TeamNode) => {
    const space: Space = { kind: 'team', team: team.team }
    const open = !collapsed.has(team.team)
    const children = [
      ...team.families.map((node) => familyItem(node, 1, team.team)),
      ...team.repos.map((repo) => repoItem(repo, 1)),
    ]
    const { shown, more } = foldList(children, TEAM_LIMIT, expanded.has(team.team))
    return (
      <li key={team.team}>
        <div className="flex items-center">
          <button
            type="button"
            aria-label={`${team.team} spaces`}
            aria-expanded={open}
            className="grid size-6 shrink-0 place-items-center text-dim hover:text-foreground"
            onClick={() => toggle(team.team)}
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <button
            type="button"
            className={itemClass(current === spaceKey(space), 0)}
            aria-current={current === spaceKey(space) ? 'true' : undefined}
            onClick={() => onSelect(space)}
          >
            <Users className="size-3.5 shrink-0" />
            <span className="truncate">
              <TeamName team={team.team} />
            </span>
            <SpaceBadge counts={counts} space={space} />
          </button>
        </div>
        {open ? (
          <ul>
            {shown}
            {more ? (
              <li>
                <button
                  type="button"
                  className="h-6 pl-6 text-left text-xs text-dim hover:text-foreground"
                  onClick={() => expand(team.team)}
                >
                  {more} more
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
    )
  }

  const folderItem = (node: FolderNode, depth: number): ReactNode => {
    const key = folderKey(node)
    const open = openFolders.has(key)
    const space: Space =
      node.folder === ''
        ? { kind: 'all' }
        : { kind: 'path', forge: node.forge, folder: node.folder }
    const active = node.folder !== '' && current === spaceKey(space)
    return (
      <li key={key}>
        <div className="flex items-center" style={{ paddingLeft: `${depth * 12}px` }}>
          {node.children.length ? (
            <button
              type="button"
              aria-label={`${node.folder || node.forge} folders`}
              aria-expanded={open}
              className="grid size-6 shrink-0 place-items-center text-dim hover:text-foreground"
              onClick={() => setOpenFolders((previous) => toggled(previous, key))}
            >
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          ) : (
            <span aria-hidden className="size-6 shrink-0" />
          )}
          {node.folder === '' ? (
            <span className="flex h-7 min-w-0 items-center gap-1.5 text-[12.5px] text-muted">
              <Globe className="size-3.5 shrink-0" />
              <span className="mono truncate text-xs">{node.forge}</span>
            </span>
          ) : (
            <button
              type="button"
              className={itemClass(active, -1)}
              aria-current={active ? 'true' : undefined}
              title={`${node.forge}:${node.folder}`}
              onClick={() => onSelect(space)}
            >
              <Folder className="size-3.5 shrink-0" />
              <span className="mono truncate text-xs">{node.name}</span>
              <span className="mono text-[11px] text-dim">{node.total}</span>
              <SpaceBadge counts={counts} space={space} />
            </button>
          )}
        </div>
        {open ? <ul>{node.children.map((child) => folderItem(child, depth + 1))}</ul> : null}
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
        <SpaceBadge counts={counts} space={{ kind: 'all' }} />
      </button>

      <ScopeSwitch value={view} onChange={setView} counts={tree.counts} />

      {noTeams ? <NoTeamsState /> : null}
      <ul className="flex flex-col gap-0.5">
        {tree.teams.map((team) => teamItem(team))}
        {tree.others.length ? (
          <li>
            <button
              type="button"
              aria-expanded={othersOpen}
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-1 text-left text-xs text-muted hover:bg-raise hover:text-foreground"
              onClick={() => setOthersOpen((open) => !open)}
            >
              <ChevronRight
                aria-hidden
                className={`size-3.5 shrink-0 transition-transform ${othersOpen ? 'rotate-90' : ''}`}
              />
              <span className="font-medium text-foreground">Other teams</span>
              <span aria-hidden className="text-dim">
                ·
              </span>
              <span className="truncate">
                {plural(tree.otherRepos, 'repository', 'repositories')}
              </span>
            </button>
            {othersOpen ? <ul>{tree.others.map((team) => teamItem(team))}</ul> : null}
          </li>
        ) : null}
        {tree.unowned.families.length || tree.unowned.repos.length ? (
          <li>
            <SidebarHeading>Not in a team</SidebarHeading>
            <ul>
              {tree.unowned.families.map((node) => familyItem(node, 0, '-'))}
              {tree.unowned.repos.map((repo) => repoItem(repo, 0))}
            </ul>
          </li>
        ) : null}
      </ul>

      {tree.folders.length ? (
        <section className="flex flex-col gap-0.5 border-t border-line pt-3">
          <SidebarHeading>Folders</SidebarHeading>
          <ul aria-label="Folders">{tree.folders.map((node) => folderItem(node, 0))}</ul>
        </section>
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
  onEdit: (initial: FamilySuggestion) => void
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
                <span
                  className="mono text-[11px] text-muted"
                  title="Lowest dependency similarity between any two members"
                >
                  {similarityText(suggestion.similarity)}
                </span>
              </div>
              <span className="mono truncate text-[11px] text-muted">
                {suggestion.members.length} repos
                {suggestion.framework ? ` · ${suggestion.framework}` : ''}
                {suggestion.toolchain.length ? ` · ${suggestion.toolchain.join(', ')}` : ''}
              </span>
              <ul
                className="flex flex-col gap-0.5"
                aria-label={`Repositories of ${suggestion.name}`}
              >
                {suggestion.members.slice(0, MEMBERS_SHOWN).map((member) => (
                  <li
                    key={member}
                    className="mono truncate text-[11px] text-foreground/80"
                    title={member}
                  >
                    {repoPathOf(member)}
                  </li>
                ))}
                {suggestion.members.length > MEMBERS_SHOWN ? (
                  <li className="text-[11px] text-dim">
                    +{suggestion.members.length - MEMBERS_SHOWN} more · Edit to see all
                  </li>
                ) : null}
              </ul>
              <div className="flex gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  isPending={create.isPending && create.variables?.members === suggestion.members}
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
                <Button variant="ghost" size="sm" onPress={() => onEdit(suggestion)}>
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
