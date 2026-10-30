import type { Block } from '@holtkeeper/api'
import type { ComponentType, ReactNode } from 'react'

import { ChangesBlock } from './blocks/ChangesBlock.tsx'
import { ChartBlock } from './blocks/ChartBlock.tsx'
import { GraphBlock } from './blocks/GraphBlock.tsx'
import { HeatmapBlock } from './blocks/HeatmapBlock.tsx'
import { IssuesBlock } from './blocks/IssuesBlock.tsx'
import { MarkdownBlock } from './blocks/MarkdownBlock.tsx'
import { MetricsBlock } from './blocks/MetricsBlock.tsx'
import { TableBlock } from './blocks/TableBlock.tsx'
import { TimelineBlock } from './blocks/TimelineBlock.tsx'
import { TreemapBlock } from './blocks/TreemapBlock.tsx'

type BlockOf<T extends Block['type']> = Extract<Block, { type: T }>

function entry<T extends Block['type']>(type: T, Component: ComponentType<{ block: BlockOf<T> }>) {
  const matches = (block: Block): block is BlockOf<T> => block.type === type
  return (block: Block): ReactNode => (matches(block) ? <Component block={block} /> : null)
}

/**
 * One renderer per block type. Adding a block type to the report model is a compile error here
 * until it gets a renderer: write `blocks/<Type>Block.tsx` and register it.
 */
export const renderers: { [T in Block['type']]: (block: Block) => ReactNode } = {
  metrics: entry('metrics', MetricsBlock),
  table: entry('table', TableBlock),
  chart: entry('chart', ChartBlock),
  treemap: entry('treemap', TreemapBlock),
  timeline: entry('timeline', TimelineBlock),
  graph: entry('graph', GraphBlock),
  issues: entry('issues', IssuesBlock),
  markdown: entry('markdown', MarkdownBlock),
  changes: entry('changes', ChangesBlock),
  heatmap: entry('heatmap', HeatmapBlock),
}
