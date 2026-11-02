import { Check } from 'lucide-react'

import { messageOf } from '../../api/client.ts'
import { useForgeRepositories, useRepos } from '../../api/queries.ts'
import { splitRepoPath } from '../../lib/repo.ts'
import { useDebounced } from '../../lib/use-debounced.ts'

/**
 * Projects the forge's token is a member of, filtered by `search`, to pick one instead of typing
 * its path. Projects Holtkeeper already works on are shown but cannot be picked.
 */
export function RepoExplorer({
  forge,
  search,
  value,
  onPick,
}: {
  forge: string
  search: string
  value: string
  onPick: (path: string) => void
}) {
  const query = useDebounced(search.trim(), 300)
  const list = useForgeRepositories(forge, query)
  const repos = useRepos()
  const added = new Set(
    (repos.data?.repos ?? [])
      .filter((entry) => entry.repo.forge === forge)
      .map((entry) => entry.repo.path),
  )
  const entries = list.data?.entries ?? []

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">Projects of the forge token</span>
      <div className="max-h-56 overflow-y-auto rounded-xl border border-separator py-1">
        {list.isError ? (
          <p className="px-3 py-2 text-xs text-muted">{messageOf(list.error)}</p>
        ) : list.isPending ? (
          <p className="px-3 py-2 text-xs text-muted">Loading projects…</p>
        ) : entries.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted">
            {query ? 'No matching projects' : 'The token is not a member of any project'}
          </p>
        ) : (
          entries.map((entry) => {
            const { namespace, name } = splitRepoPath(entry.path)
            const isAdded = added.has(entry.path)
            const selected = entry.path === value.trim()
            return (
              <button
                key={entry.path}
                type="button"
                disabled={isAdded}
                onClick={() => onPick(entry.path)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-default/40 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent ${selected ? 'bg-default/60' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                  <span className="text-muted">{namespace}</span>
                  {name}
                </span>
                {isAdded ? (
                  <span className="text-[11px] text-muted">added</span>
                ) : selected ? (
                  <Check className="size-3.5 shrink-0 text-accent" />
                ) : null}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
