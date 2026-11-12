import { Check } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useForgeRepositories } from '../../api/queries.ts'
import { splitRepoPath } from '../../lib/repo.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import { SearchInput } from '../../ui/index.ts'

/**
 * Projects the forge's token is a member of, searchable, to pick several instead of typing their
 * paths. `added` projects are shown but cannot be picked.
 */
export function RepoExplorer({
  forge,
  selected,
  added,
  onToggle,
}: {
  forge: string
  selected: readonly string[]
  added: ReadonlySet<string>
  onToggle: (path: string) => void
}) {
  const [search, setSearch] = useState('')
  const query = useDebounced(search.trim(), 300)
  const list = useForgeRepositories(forge, query)
  const entries = list.data?.entries ?? []

  return (
    <div className="flex flex-col gap-1.5">
      <SearchInput
        aria-label="Search projects of the forge token"
        placeholder="Search projects of the token"
        value={search}
        onChange={setSearch}
      />
      <div
        role="group"
        aria-label="Projects of the forge token"
        className="max-h-64 overflow-y-auto rounded-xl border border-line py-1"
      >
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
            const isSelected = selected.includes(entry.path)
            return (
              <button
                key={entry.path}
                type="button"
                aria-pressed={isSelected}
                disabled={isAdded}
                onClick={() => onToggle(entry.path)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raise disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent ${isSelected ? 'bg-raise' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                  <span className="text-muted">{namespace}</span>
                  {name}
                </span>
                {isAdded ? (
                  <span className="text-[11px] text-muted">added</span>
                ) : isSelected ? (
                  <Check aria-hidden className="size-3.5 shrink-0 text-accent" />
                ) : null}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
