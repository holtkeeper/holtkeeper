import type { RepoRef } from '@holtkeeper/api'
import { ChevronDown, ChevronRight, Folder, FolderOpen, Globe } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import { type FolderNode, folderAncestors, folderKey, folderTree } from '../../lib/repos.ts'

const rowClass = (current: boolean) =>
  `flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] transition-colors ${
    current
      ? 'bg-raise text-foreground shadow-[0_0_0_1px_var(--line-strong)]'
      : 'text-muted hover:bg-raise hover:text-foreground'
  }`

/**
 * The repositories' folders as a collapsible tree derived from their paths: one root per forge,
 * the forge root left out while there is a single forge. Picking a folder narrows the list to the
 * repositories below it (`selected` is its `forge:folder` key); the folders holding the selection
 * start open.
 */
export function FolderTree({
  repos,
  selected,
  onSelect,
}: {
  repos: readonly RepoRef[]
  selected: string | undefined
  onSelect: (key: string | undefined) => void
}) {
  const tree = useMemo(() => folderTree(repos), [repos])
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(selected ? [...folderAncestors(selected), selected] : []),
  )
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const item = (node: FolderNode, depth: number): ReactNode => {
    const key = folderKey(node)
    const expanded = open.has(key)
    const current = selected === key
    return (
      <li key={key}>
        <div className="flex items-center" style={{ paddingLeft: `${depth * 12}px` }}>
          {node.children.length ? (
            <button
              type="button"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.folder || node.forge}`}
              aria-expanded={expanded}
              className="grid size-6 shrink-0 place-items-center text-dim hover:text-foreground"
              onClick={() => toggle(key)}
            >
              {expanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
          ) : (
            <span aria-hidden className="size-6 shrink-0" />
          )}
          <button
            type="button"
            className={rowClass(current)}
            aria-current={current ? 'true' : undefined}
            title={node.folder ? `${node.forge}:${node.folder}` : `Forge ${node.forge}`}
            onClick={() => onSelect(current ? undefined : key)}
          >
            {node.folder === '' ? (
              <Globe className="size-3.5 shrink-0" />
            ) : expanded ? (
              <FolderOpen className="size-3.5 shrink-0" />
            ) : (
              <Folder className="size-3.5 shrink-0" />
            )}
            <span className="mono truncate text-xs">{node.name}</span>
            <span className="mono ml-auto text-[11px] text-dim">{node.total}</span>
          </button>
        </div>
        {expanded && node.children.length ? (
          <ul>{node.children.map((child) => item(child, depth + 1))}</ul>
        ) : null}
      </li>
    )
  }

  return (
    <nav aria-label="Folders" className="flex flex-col gap-0.5 text-sm">
      <button
        type="button"
        className={rowClass(selected === undefined)}
        aria-current={selected === undefined ? 'true' : undefined}
        onClick={() => onSelect(undefined)}
      >
        <span className="size-6 shrink-0" aria-hidden />
        All folders
        <span className="mono ml-auto text-[11px] text-dim">{repos.length}</span>
      </button>
      <ul>{tree.map((node) => item(node, 0))}</ul>
    </nav>
  )
}
