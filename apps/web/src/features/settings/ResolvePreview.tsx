import type { Scope, SettingDefinitionView, SettingView } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, Plus, Wand2 } from 'lucide-react'

import { useRepos, useResolvedSettings } from '../../api/queries.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { previewValue } from '../../lib/schema.ts'
import { Chip, EmptyState, ErrorState, Loading, Panel, Select } from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'

/**
 * How every setting cascades onto a chosen repository: the entries covering it from broad to
 * narrow, the one that applies last and highlighted. With `onEdit` and `onAdd`, clicking an entry
 * edits it and the trailing slot adds an override for just this repository.
 */
export function ResolvePreview({
  definitions,
  onEdit,
  onAdd,
}: {
  definitions: readonly SettingDefinitionView[]
  onEdit?: (definition: SettingDefinitionView, entry: SettingView) => void
  onAdd?: (definition: SettingDefinitionView, scope: Scope) => void
}) {
  const search = useSearch({ from: '/app/settings' })
  const navigate = useNavigate({ from: '/settings' })
  const repos = useRepos()
  const repo = parseRepoKey(search.repo)
  const resolved = useResolvedSettings(repo)

  return (
    <Panel
      title="Resolve for repository"
      description="Entries covering the repository, from broad to narrow; the narrowest applies and overrides the rest"
      actions={
        <Select
          aria-label="Repository"
          className="w-72"
          placeholder="Choose a repository"
          options={(repos.data?.repos ?? []).map((r) => ({
            id: repoKey(r.repo),
            label: repoKey(r.repo),
          }))}
          value={search.repo}
          onChange={(id) =>
            void navigate({ search: (previous) => ({ ...previous, repo: id }), replace: true })
          }
        />
      }
    >
      {!repo ? (
        <EmptyState
          icon={<Wand2 />}
          title="Pick a repository"
          description="See the effective value of every setting for it."
        />
      ) : resolved.isPending ? (
        <Loading />
      ) : resolved.isError ? (
        <ErrorState error={resolved.error} />
      ) : (
        <div className="flex flex-col gap-3">
          {resolved.data.groups.length ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              Groups:
              {resolved.data.groups.map((group) => (
                <Chip key={group}>{group}</Chip>
              ))}
            </div>
          ) : null}
          <ol className="flex flex-col divide-y divide-separator">
            {definitions.map((definition) => {
              const cascade = resolved.data.cascade[definition.key] ?? []
              const own = cascade[0]?.scope.repos?.includes(repoKey(repo)) ?? false
              return (
                <li
                  key={definition.key}
                  className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:gap-4"
                >
                  <div className="min-w-0 md:w-56 md:shrink-0">
                    <div className="truncate font-medium">{definition.label}</div>
                    <div className="truncate font-mono text-[11px] text-muted">
                      {definition.key}
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {cascade.length === 0 ? (
                      <span className="rounded-lg border border-dashed border-border px-2.5 py-1.5 text-xs text-muted">
                        default
                      </span>
                    ) : null}
                    {cascade.toReversed().map((entry, i, list) => (
                      <CascadeStep
                        key={entry.id}
                        entry={entry}
                        applies={i === list.length - 1}
                        first={i === 0}
                        {...(onEdit ? { onPress: () => onEdit(definition, entry) } : {})}
                      />
                    ))}
                    {onAdd && !own ? (
                      <>
                        <ChevronRight className="size-3.5 shrink-0 text-muted" />
                        <button
                          type="button"
                          className="flex items-center gap-1 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-xs text-muted hover:border-accent hover:text-foreground"
                          onClick={() => onAdd(definition, { repos: [repoKey(repo)] })}
                        >
                          <Plus className="size-3.5" />
                          Only here
                        </button>
                      </>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </Panel>
  )
}

function CascadeStep({
  entry,
  applies,
  first,
  onPress,
}: {
  entry: SettingView
  applies: boolean
  first: boolean
  onPress?: () => void
}) {
  const body = (
    <>
      <ScopeBadge scope={entry.scope} />
      <span className={`max-w-56 truncate font-mono text-xs ${applies ? '' : 'line-through'}`}>
        {previewValue(entry.value, entry.secret)}
      </span>
      {applies ? <Chip tone="success">applies</Chip> : null}
    </>
  )
  const className = `flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1 ${
    applies ? 'border-accent bg-surface shadow-surface' : 'border-border opacity-60'
  }`
  return (
    <>
      {first ? null : <ChevronRight className="size-3.5 shrink-0 text-muted" />}
      {onPress ? (
        <button
          type="button"
          className={`${className} text-left hover:opacity-100`}
          title={applies ? 'Applies here; click to edit' : 'Overridden here; click to edit'}
          onClick={onPress}
        >
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
      )}
    </>
  )
}
