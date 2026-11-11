import type { GuideTask, RepoRef } from '@holtkeeper/api'
import { useState } from 'react'

import { useGuidePreview } from '../../api/queries.ts'
import { budgetSegments, guideTasks } from '../../lib/guide.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import {
  ErrorState,
  Notice,
  Placeholder,
  SegmentBar,
  Select,
  SideSheet,
  Tag,
} from '../../ui/index.ts'

const isGuideTask = (value: string): value is GuideTask => guideTasks.some((t) => t.id === value)

/**
 * The exact Guide text a task of a repository gets from the panel, with the character budget per
 * layer and the resolver's warnings. Rules files in the repository are read by the task itself.
 */
export function PreviewSheet({
  repos,
  initial,
  onClose,
}: {
  /** Repositories to choose from, `forge:path`. */
  repos: readonly string[]
  initial?: RepoRef
  onClose: () => void
}) {
  const [repo, setRepo] = useState<RepoRef | undefined>(
    initial ?? parseRepoKey(repos[0] ?? undefined),
  )
  const [task, setTask] = useState<GuideTask>('review')

  return (
    <SideSheet open onClose={onClose} title="Effective prompt">
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Select
            label="Repository"
            options={repos.map((key) => ({ id: key, label: key }))}
            value={repo ? repoKey(repo) : undefined}
            onChange={(key) => setRepo(parseRepoKey(key))}
            placeholder="Choose a repository"
          />
          <Select
            label="Task"
            options={guideTasks}
            value={task}
            onChange={(id) => isGuideTask(id) && setTask(id)}
          />
        </div>
        {repo ? (
          <EffectivePrompt repo={repo} task={task} />
        ) : (
          <p className="text-sm text-muted">Choose a repository to see what its tasks get.</p>
        )}
      </div>
    </SideSheet>
  )
}

/** The Guide text `task` gets on `repo`, with the budget per layer, warnings and every block. */
export function EffectivePrompt({ repo, task }: { repo: RepoRef; task: GuideTask }) {
  const preview = useGuidePreview(repo, task)
  if (preview.isPending) return <Placeholder className="h-64" />
  if (preview.isError) return <ErrorState error={preview.error} />
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <SegmentBar
          segments={budgetSegments(preview.data.budget)}
          total={preview.data.budget.total}
        />
        <div className="mono flex flex-wrap gap-x-3 text-xs text-muted">
          <span>
            {preview.data.budget.used.toLocaleString()} /{' '}
            {preview.data.budget.total.toLocaleString()} chars
          </span>
          <span className="text-accent">human {preview.data.budget.humanUsed}</span>
          <span className="text-code">generated {preview.data.budget.generatedUsed}</span>
          <span className="text-info">notes {preview.data.budget.notesUsed}</span>
        </div>
      </div>
      {preview.data.warnings.length ? (
        <Notice tone="warning" title="Warnings">
          <ul className="list-disc pl-4">
            {preview.data.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
        {preview.data.blocks.map((block, index) => (
          <li
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm"
          >
            <Tag mono>{block.layer}</Tag>
            <span className="min-w-0 flex-1 truncate">{block.title}</span>
            {block.proposed ? <Tag tone="warning">proposed</Tag> : null}
            {block.cut ? <Tag tone="danger">cut</Tag> : null}
            <span className="mono text-xs text-muted">
              {block.chars}
              {block.chars === block.fullChars ? '' : ` / ${block.fullChars}`}
            </span>
          </li>
        ))}
        {preview.data.blocks.length === 0 ? (
          <li className="px-3 py-2 text-sm text-muted">Nothing applies to this task.</li>
        ) : null}
      </ul>
      {preview.data.text ? (
        <pre className="mono max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-raise p-3 text-xs">
          {preview.data.text}
        </pre>
      ) : null}
    </>
  )
}
