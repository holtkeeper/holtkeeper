import type { Block } from '@holtkeeper/api'
import { Puzzle } from 'lucide-react'
import type { ReactNode } from 'react'

import { renderers } from './registry.tsx'

/** Renders any block; types this client does not know yet get a neutral placeholder. */
export function BlockView({ block }: { block: Block }) {
  const render: ((block: Block) => ReactNode) | undefined = Object.hasOwn(renderers, block.type)
    ? renderers[block.type]
    : undefined
  const title = 'title' in block ? block.title : undefined
  return (
    <div className="flex flex-col gap-3">
      {title ? <h3 className="text-sm font-semibold">{title}</h3> : null}
      {render ? (
        render(block)
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-dashed border-border p-4 text-sm text-muted">
          <Puzzle className="size-4" />
          This report contains a “{block.type}” block that this version of the panel cannot show
          yet.
        </div>
      )}
    </div>
  )
}
