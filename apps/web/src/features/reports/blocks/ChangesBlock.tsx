import type { ApplyChangesResult, Block, ChangeItem, Conflict } from '@holtkeeper/api'
import {
  CheckCheck,
  ClipboardCopy,
  Download,
  GitPullRequestArrow,
  TriangleAlert,
  Wand2,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { use, useState } from 'react'

import { messageOf } from '../../../api/client.ts'
import { useApplyChanges } from '../../../api/queries.ts'
import { diffStats } from '../../../lib/diff.ts'
import { plural } from '../../../lib/format.ts'
import { isMarkupFile } from '../../../lib/markup.ts'
import {
  conflictsByChange,
  mergeRequestTitle,
  selectAllSafe,
  selectedIds,
  toggle,
} from '../../../lib/selection.ts'
import { toneColor } from '../../../lib/units.ts'
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  EmptyState,
  Segmented,
  TextField,
  notify,
} from '../../../ui/index.ts'
import { ReportContext } from '../context.ts'
import { type DiffMode, FileDiffView } from './DiffView.tsx'

const largeDiff = 300

function downloadPatch(patch: string, name: string) {
  const url = URL.createObjectURL(new Blob([patch], { type: 'text/x-diff' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ChangeCard({
  item,
  mode,
  formatted,
  selectable,
  selected,
  onSelect,
  conflicts,
}: {
  item: ChangeItem
  mode: DiffMode
  formatted: boolean
  selectable: boolean
  selected: boolean
  onSelect: (on: boolean) => void
  conflicts: readonly Conflict[] | undefined
}) {
  const { change } = item
  const stats = diffStats(item.diff)
  const openFiles = stats.added + stats.removed <= largeDiff
  return (
    <motion.li
      layout="position"
      className="relative flex flex-col gap-3 overflow-hidden rounded-2xl border bg-surface p-4 shadow-surface transition-colors"
      style={{
        borderColor: selected ? 'var(--accent)' : conflicts ? 'var(--danger)' : 'var(--border)',
      }}
    >
      {item.tone ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1"
          style={{ background: toneColor[item.tone] }}
        />
      ) : null}
      <div className="flex items-start gap-3">
        {selectable ? (
          <div className="pt-0.5">
            <Checkbox
              label={<span className="sr-only">Select {change.title}</span>}
              isSelected={selected}
              onChange={onSelect}
            />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{change.title}</span>
            <Chip tone={change.confidence === 'safe' ? 'success' : 'warning'}>
              {change.confidence}
            </Chip>
            <Chip variant="secondary">{change.source}</Chip>
            {item.tags?.map((tag) => (
              <span
                key={tag}
                className="rounded-md bg-default-soft px-1.5 py-0.5 text-[11px] text-muted"
              >
                {tag}
              </span>
            ))}
            <span className="ml-auto font-mono text-xs tabular text-muted">
              {plural(stats.files, 'file')} · <span className="text-success">+{stats.added}</span>{' '}
              <span className="text-danger">−{stats.removed}</span>
            </span>
          </div>
          {change.description ? (
            <p className="whitespace-pre-wrap text-sm text-muted">{change.description}</p>
          ) : null}
        </div>
      </div>
      {conflicts ? (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-xl bg-danger-soft p-3 text-sm text-danger-soft-foreground"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <TriangleAlert className="size-4" />
            Not applied: the files changed since this analysis
          </span>
          <ul className="flex flex-col gap-0.5 text-xs">
            {conflicts.map((conflict, index) => (
              <li key={index}>
                <span className="font-mono">{conflict.file}</span> — {conflict.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {item.diff.map((file) => (
          <FileDiffView
            key={file.file}
            file={file}
            mode={mode}
            formatted={formatted}
            defaultOpen={openFiles}
          />
        ))}
      </div>
    </motion.li>
  )
}

/** Proposed code changes as reviewable diffs; when allowed, accept a selection as a patch or merge request. */
export function ChangesBlock({ block }: { block: Extract<Block, { type: 'changes' }> }) {
  const actions = use(ReportContext)
  const actionable = block.applicable && actions?.canApply === true
  const [mode, setMode] = useState<DiffMode>('unified')
  const [view, setView] = useState<'formatted' | 'raw'>('formatted')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<ApplyChangesResult>()
  const [titleDialog, setTitleDialog] = useState(false)
  const [title, setTitle] = useState('')
  const apply = useApplyChanges(actions?.analysisId ?? '')
  const conflicts = conflictsByChange(result?.conflicts ?? [])
  const ids = selectedIds(selection, block.items)
  const hasMarkup = block.items.some((i) => i.diff.some((f) => isMarkupFile(f.file)))
  const safeCount = block.items.filter((i) => i.change.confidence === 'safe').length

  if (block.items.length === 0) return <EmptyState icon={<Wand2 />} title="No suggested changes" />

  const reportConflicts = (outcome: ApplyChangesResult) => {
    setResult(outcome)
    if (outcome.conflicts.length) {
      notify.error(
        `${plural(new Set(outcome.conflicts.map((c) => c.changeId)).size, 'change')} could not be applied`,
        'See the marked cards.',
      )
    }
  }

  const patch = (then: (text: string) => void) =>
    apply.mutate(
      { ids, mode: 'patch' },
      {
        onSuccess: (outcome) => {
          reportConflicts(outcome)
          if (outcome.patch) then(outcome.patch)
        },
        onError: (error) => notify.error('Could not build the patch', messageOf(error)),
      },
    )

  const openMergeRequest = () =>
    apply.mutate(
      { ids, mode: 'merge-request', ...(title.trim() ? { title: title.trim() } : {}) },
      {
        onSuccess: (outcome) => {
          setTitleDialog(false)
          reportConflicts(outcome)
          if (outcome.mergeRequest) {
            const url = outcome.mergeRequest.url
            notify.success(
              `Merge request !${outcome.mergeRequest.id} opened`,
              <a href={url} target="_blank" rel="noreferrer" className="underline">
                {url}
              </a>,
            )
            setSelection(new Set())
          }
        },
        onError: (error) => notify.error('Merge request not opened', messageOf(error)),
      },
    )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">
          {plural(block.items.length, 'change')} · {safeCount} safe
        </span>
        <span className="ml-auto" />
        {actionable && safeCount ? (
          <Button
            variant="secondary"
            size="sm"
            onPress={() => setSelection((s) => selectAllSafe(s, block.items, conflicts))}
          >
            <CheckCheck className="size-4" />
            Select all safe
          </Button>
        ) : null}
        {actionable && ids.length ? (
          <Button variant="ghost" size="sm" onPress={() => setSelection(new Set())}>
            Clear
          </Button>
        ) : null}
        <Segmented
          aria-label="Diff layout"
          options={[
            { id: 'unified', label: 'Unified' },
            { id: 'split', label: 'Split' },
          ]}
          value={mode}
          onChange={setMode}
        />
        {hasMarkup ? (
          <Segmented
            aria-label="Markup lines"
            options={[
              { id: 'formatted', label: 'Formatted' },
              { id: 'raw', label: 'Raw' },
            ]}
            value={view}
            onChange={setView}
          />
        ) : null}
      </div>

      <ul className="flex flex-col gap-3">
        {block.items.map((item) => (
          <ChangeCard
            key={item.change.id}
            item={item}
            mode={mode}
            formatted={view === 'formatted'}
            selectable={actionable}
            selected={selection.has(item.change.id)}
            onSelect={(on) => setSelection((s) => toggle(s, item.change.id, on))}
            conflicts={conflicts.get(item.change.id)}
          />
        ))}
      </ul>

      <AnimatePresence>
        {actionable && ids.length ? (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="sticky bottom-4 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-overlay/95 p-3 shadow-overlay backdrop-blur"
            role="toolbar"
            aria-label="Accept selected changes"
          >
            <span className="text-sm font-medium">{plural(ids.length, 'change')} selected</span>
            <span className="ml-auto" />
            <Button
              variant="secondary"
              size="sm"
              isPending={apply.isPending && apply.variables?.mode === 'patch'}
              onPress={() =>
                patch((text) =>
                  downloadPatch(text, `holtkeeper-${actions?.analysisId ?? 'changes'}.patch`),
                )
              }
            >
              <Download className="size-4" />
              Download patch
            </Button>
            <Button
              variant="secondary"
              size="sm"
              isDisabled={apply.isPending}
              onPress={() =>
                patch((text) => {
                  navigator.clipboard.writeText(text).then(
                    () => notify.success('Patch copied', 'Apply it with git apply.'),
                    (error: unknown) => notify.error('Could not copy', messageOf(error)),
                  )
                })
              }
            >
              <ClipboardCopy className="size-4" />
              Copy patch
            </Button>
            <Button
              variant="primary"
              size="sm"
              isDisabled={apply.isPending}
              onPress={() => {
                setTitle(mergeRequestTitle(block.items, ids))
                setTitleDialog(true)
              }}
            >
              <GitPullRequestArrow className="size-4" />
              Open merge request
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Dialog
        isOpen={titleDialog}
        onOpenChange={setTitleDialog}
        title="Open merge request"
        description={`${plural(ids.length, 'change')} go on a new branch; conflicting ones are skipped.`}
        footer={
          <>
            <Button variant="tertiary" onPress={() => setTitleDialog(false)}>
              Cancel
            </Button>
            <Button variant="primary" onPress={openMergeRequest} isPending={apply.isPending}>
              Open merge request
            </Button>
          </>
        }
      >
        <TextField label="Title" value={title} onChange={setTitle} autoFocus />
      </Dialog>
    </div>
  )
}
