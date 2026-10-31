import type { DiffLine, FileDiff } from '@holtkeeper/api'
import { ChevronRight, FileCode2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

import { type SplitCell, diffStats, hunkHeader, splitRows, unifiedRows } from '../../../lib/diff.ts'
import { formatMarkupLine } from '../../../lib/markup.ts'
import { Chip, tableScrollClass } from '../../../ui/index.ts'

/** How diffs are laid out: one column with both sides, or old and new side by side. */
export type DiffMode = 'unified' | 'split'

const lineClass: Record<DiffLine['kind'], string> = {
  add: 'bg-success-soft',
  remove: 'bg-danger-soft',
  context: '',
}

const sign: Record<DiffLine['kind'], string> = { add: '+', remove: '−', context: ' ' }

function LineText({ file, text, formatted }: { file: string; text: string; formatted: boolean }) {
  const lines = formatted ? formatMarkupLine(file, text) : undefined
  if (!lines) return <>{text || ' '}</>
  return (
    <span
      title="One line, formatted for reading"
      className="inline-block border-l border-dashed border-muted pl-2 align-top"
    >
      {lines.join('\n')}
    </span>
  )
}

const gutter = 'w-px select-none whitespace-nowrap px-2 text-right align-top text-muted tabular'

function Code({
  file,
  text,
  kind,
  formatted,
}: {
  file: string
  text: string
  kind: DiffLine['kind']
  formatted: boolean
}) {
  return (
    <td className="whitespace-pre px-2 align-top">
      <span aria-hidden className="mr-2 select-none text-muted">
        {sign[kind]}
      </span>
      <span className="sr-only">
        {kind === 'add' ? 'added: ' : kind === 'remove' ? 'removed: ' : ''}
      </span>
      <LineText file={file} text={text} formatted={formatted} />
    </td>
  )
}

function SplitSide({
  file,
  cell,
  formatted,
}: {
  file: string
  cell: SplitCell | undefined
  formatted: boolean
}) {
  if (!cell) {
    return (
      <>
        <td className={`${gutter} bg-default-soft`} />
        <td className="bg-default-soft" />
      </>
    )
  }
  return (
    <>
      <td className={`${gutter} ${lineClass[cell.kind]}`}>{cell.no}</td>
      <td className={`whitespace-pre px-2 align-top ${lineClass[cell.kind]}`}>
        <LineText file={file} text={cell.text} formatted={formatted} />
      </td>
    </>
  )
}

/**
 * One file of a change: header with status and line counts, collapsible hunks. With `formatted`,
 * long minified SVG, XML or HTML lines are shown indented while keeping their single line number.
 */
export function FileDiffView({
  file,
  mode,
  formatted,
  defaultOpen,
}: {
  file: FileDiff
  mode: DiffMode
  formatted: boolean
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const stats = diffStats([file])
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-default-soft px-3 py-2 text-left text-sm hover:bg-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} className="inline-flex">
          <ChevronRight className="size-4 text-muted" />
        </motion.span>
        <FileCode2 className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 truncate font-mono text-[12px]">{file.file}</span>
        {file.status === 'added' ? <Chip tone="success">added file</Chip> : null}
        {file.status === 'deleted' ? <Chip tone="danger">deleted file</Chip> : null}
        <span className="ml-auto shrink-0 font-mono text-xs tabular">
          <span className="text-success">+{stats.added}</span>{' '}
          <span className="text-danger">−{stats.removed}</span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className={tableScrollClass}>
              <table className="w-full border-collapse font-mono text-[12px] leading-5">
                {file.hunks.map((hunk, index) => (
                  <tbody key={index}>
                    <tr>
                      <td
                        colSpan={mode === 'split' ? 4 : 3}
                        className="bg-accent-soft px-3 py-1 text-[11px] text-accent-soft-foreground"
                      >
                        {hunkHeader(hunk)}
                      </td>
                    </tr>
                    {mode === 'unified'
                      ? unifiedRows(hunk).map((row, i) => (
                          <tr key={i} className={lineClass[row.kind]}>
                            <td className={gutter}>{row.old ?? ''}</td>
                            <td className={gutter}>{row.new ?? ''}</td>
                            <Code
                              file={file.file}
                              text={row.text}
                              kind={row.kind}
                              formatted={formatted}
                            />
                          </tr>
                        ))
                      : splitRows(hunk).map((row, i) => (
                          <tr key={i}>
                            <SplitSide file={file.file} cell={row.left} formatted={formatted} />
                            <SplitSide file={file.file} cell={row.right} formatted={formatted} />
                          </tr>
                        ))}
                  </tbody>
                ))}
              </table>
              {file.hunks.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted">No textual changes.</p>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
