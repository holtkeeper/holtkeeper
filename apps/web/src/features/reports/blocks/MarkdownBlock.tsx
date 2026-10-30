import type { Block } from '@holtkeeper/api'

import { Markdown } from '../../../ui/index.ts'

/** A markdown block of a report. */
export function MarkdownBlock({ block }: { block: Extract<Block, { type: 'markdown' }> }) {
  return <Markdown text={block.text} className="max-w-3xl" />
}
