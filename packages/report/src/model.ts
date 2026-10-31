import type { CodeChange, FileDiff } from '@holtkeeper/changes'
import type { RepoRef } from '@holtkeeper/forge'

/**
 * The universal output of every analysis. Analyzers turn their own data into a `Report`; clients
 * render any report from these blocks without knowing which analysis produced it.
 */
export interface Report {
  /** Analysis kind, e.g. `changelog`, `bundle`, `depgraph`. */
  kind: string
  title: string
  subtitle?: string
  subject?: {
    repo?: RepoRef
    /** Release, tag or commit the report describes. */
    ref?: string
    /** Ref the report compares against, when it is a comparison. */
    compareTo?: string
  }
  generatedAt: string
  /** Headline numbers shown on top and in lists. */
  metrics: Metric[]
  sections: Section[]
}

export interface Section {
  id: string
  title: string
  description?: string
  blocks: Block[]
}

/** Colors carry meaning, not decoration: renderers map them to the theme. */
export type Tone = 'neutral' | 'info' | 'good' | 'warning' | 'bad'

/** How to display a number. Renderers format bytes, durations and percentages consistently. */
export type Unit = 'count' | 'bytes' | 'percent' | 'ms' | 'version' | 'text'

export interface Metric {
  id: string
  label: string
  value: number | string
  unit?: Unit
  /** Change against the compared report, in the same unit. */
  delta?: number
  /** Whether a positive delta is good (`up`) or bad (`down`), e.g. bundle size is `down`. */
  better?: 'up' | 'down'
  tone?: Tone
  hint?: string
}

/** A link or a value with a tone; plain values are allowed too. */
export type Cell =
  | string
  | number
  | boolean
  | null
  | {
      text: string
      href?: string
      tone?: Tone
      hint?: string
      /** Value the cell sorts by when `text` is formatted, e.g. `+23%` sorting as 23. */
      value?: number
      /** Values drawn as a sparkline in `sparkline` columns; `null` leaves a gap. */
      series?: (number | null)[]
    }

export interface Column {
  key: string
  label: string
  /** Shown on hover over the header, e.g. the full name behind a shortened label. */
  hint?: string
  unit?: Unit
  /** `delta` cells are numbers shown as signed changes colored by `better`. */
  /** `sparkline` cells draw their `series` next to their text, in the column's unit. */
  format?: 'text' | 'code' | 'delta' | 'date' | 'tags' | 'sparkline'
  better?: 'up' | 'down'
  align?: 'start' | 'end'
}

export interface TreeNode {
  name: string
  /** Leaf size; parents sum their children when omitted. */
  value?: number
  tone?: Tone
  children?: TreeNode[]
}

export interface TimelineItem {
  id: string
  at: string
  title: string
  subtitle?: string
  href?: string
  tone?: Tone
  tags?: string[]
  /** Collapsed duplicates or details, e.g. identical commit messages. */
  children?: TimelineItem[]
}

export interface GraphNode {
  id: string
  label: string
  /** Nodes with the same group are drawn together, e.g. workspace vs dependency. */
  group?: string
  tone?: Tone
  /** Relative weight, e.g. bundle bytes or dependents count. */
  size?: number
  detail?: string
}

export interface GraphEdge {
  from: string
  to: string
  label?: string
  tone?: Tone
  dashed?: boolean
}

export interface Issue {
  id: string
  tone: Tone
  title: string
  detail?: string
  href?: string
  tags?: string[]
}

/** A suggested code change with its rendered diff. */
export interface ChangeItem {
  change: CodeChange
  diff: FileDiff[]
  tone?: Tone
  tags?: string[]
}

export interface ChartSeries {
  key: string
  label: string
  tone?: Tone
  /** How a `combo` chart draws the series; default `bar`. */
  as?: 'bar' | 'line' | 'area'
  /** Axis of a `combo` chart; default `left`. */
  axis?: 'left' | 'right'
  dashed?: boolean
}

export interface ChartBand {
  low: string
  high: string
  label: string
  tone?: Tone
}

/** One heatmap row; `null` cells have no data. */
export interface HeatmapRow {
  label: string
  href?: string
  /** One per column: `value` drives the color, `text` replaces the formatted value in tooltips. */
  cells: ({ value: number; text?: string } | null)[]
}

export type Block =
  | { type: 'metrics'; metrics: Metric[] }
  | {
      type: 'table'
      title?: string
      columns: Column[]
      rows: Record<string, Cell>[]
      groupBy?: string
    }
  | {
      type: 'chart'
      title?: string
      /** `combo` draws each series `as` a bar, line or area, on the left or right axis. */
      chart: 'bar' | 'stacked-bar' | 'line' | 'area' | 'donut' | 'combo'
      unit?: Unit
      /** Unit of the right axis of a `combo` chart. */
      rightUnit?: Unit
      /** Category key of each datum, e.g. a release name. */
      x: string
      series: ChartSeries[]
      /** Shaded ranges between two keys of each datum, e.g. p25–p75 around a median line. */
      bands?: ChartBand[]
      /** Vertical markers at category values, e.g. when a job became slower. */
      markers?: { x: string; label: string; tone?: Tone }[]
      /** Missing keys leave gaps in lines and bands. */
      data: Record<string, string | number | null>[]
    }
  | {
      type: 'heatmap'
      title?: string
      /** Column labels, e.g. weeks. */
      xLabels: string[]
      /** One row per subject, e.g. per job; field names differ from `table` on purpose. */
      yRows: HeatmapRow[]
      /** Unit of cell values, for their text and the legend. */
      unit?: Unit
      /**
       * `sequential`: 0 is blank and `max` (default: largest value) is full `tone`.
       * `diverging`: 0 is blank; values toward ±`limit` (default: largest magnitude) color by
       * `better`, like deltas.
       */
      scale:
        | { kind: 'sequential'; tone: Tone; max?: number }
        | { kind: 'diverging'; better: 'up' | 'down'; limit?: number }
    }
  | { type: 'treemap'; title?: string; unit?: Unit; root: TreeNode }
  | { type: 'timeline'; title?: string; items: TimelineItem[] }
  | {
      type: 'graph'
      title?: string
      nodes: GraphNode[]
      edges: GraphEdge[]
      /** Node id paths to emphasize, e.g. dependency cycles. */
      highlight?: string[][]
      layout?: 'layered' | 'force'
    }
  | { type: 'issues'; title?: string; items: Issue[] }
  | { type: 'markdown'; text: string }
  | {
      type: 'changes'
      title?: string
      items: ChangeItem[]
      /** Whether clients may offer to accept these changes (download a patch, open a merge request). */
      applicable: boolean
    }
