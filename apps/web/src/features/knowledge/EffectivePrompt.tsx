import type { GuidePreview, GuideTask, RepoRef } from '@holtkeeper/api'
import { useNavigate } from '@tanstack/react-router'
import { MessageSquare, X } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useChatMutations, useGuidePreview } from '../../api/queries.ts'
import { formatCount as number } from '../../lib/format.ts'
import { budgetSegments, guideTasks, tokensOf } from '../../lib/guide.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import {
  Button,
  CopyButton,
  ErrorState,
  Legend,
  Notice,
  Placeholder,
  SegmentBar,
  Segmented,
  Select,
  Tag,
  UnderlineTabs,
  notify,
} from '../../ui/index.ts'

/** The budget bar with its legend: used of 12,000 characters, about how many tokens. */
export function BudgetBar({ budget }: { budget: Parameters<typeof budgetSegments>[0] }) {
  const segments = budgetSegments(budget)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="mono text-[13px] font-semibold">{number(budget.used)}</span>
        <span className="mono text-muted">/ {number(budget.total)} chars</span>
        <span className="mono text-dim">≈ {number(tokensOf(budget.used))} tokens</span>
      </div>
      <SegmentBar segments={segments.slice(0, 3)} total={budget.total} />
      <Legend
        label="Budget"
        items={segments.map((segment) => ({
          tone: segment.key === 'Free' ? 'none' : segment.tone,
          label: (
            <>
              {segment.key} <span className="mono">{number(segment.value)}</span>
            </>
          ),
        }))}
      />
    </div>
  )
}

function Blocks({ preview }: { preview: GuidePreview }) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
      {preview.blocks.map((block, index) => (
        <li
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm"
        >
          <Tag mono>{block.layer}</Tag>
          <span className="min-w-0 flex-1 truncate" title={block.title}>
            {block.source}
          </span>
          {block.proposed ? <Tag tone="warning">proposed</Tag> : null}
          {block.cut ? <Tag tone="danger">cut</Tag> : null}
          <span className="mono text-xs text-muted">{charsOf(block)}</span>
        </li>
      ))}
      {preview.blocks.length === 0 ? (
        <li className="px-3 py-2 text-sm text-muted">Nothing applies to this task.</li>
      ) : null}
    </ul>
  )
}

/** `1,200 chars` for a whole block, `800 / 1,200 chars` for a cut one. */
export const charsOf = (block: { chars: number; fullChars: number }) =>
  `${number(block.chars)}${block.chars === block.fullChars ? '' : ` / ${number(block.fullChars)}`} chars`

/** Resolver warnings as one notice; nothing when there are none. */
export function Warnings({ warnings }: { warnings: readonly string[] }) {
  if (!warnings.length) return null
  return (
    <Notice tone="warning" title="Warnings">
      <ul className="list-disc pl-4">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </Notice>
  )
}

const FullText = ({ text }: { text: string }) =>
  text ? (
    <pre className="mono max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-raise p-3 text-xs">
      {text}
    </pre>
  ) : (
    <p className="text-sm text-muted">Nothing applies to this task.</p>
  )

/** The Guide text `task` gets on `repo`: budget, warnings, every block and the full text. */
export function EffectivePrompt({ repo, task }: { repo: RepoRef; task: GuideTask }) {
  const preview = useGuidePreview(repo, task)
  if (preview.isPending) return <Placeholder className="h-64" />
  if (preview.isError) return <ErrorState error={preview.error} />
  return (
    <>
      <BudgetBar budget={preview.data.budget} />
      <Warnings warnings={preview.data.warnings} />
      <Blocks preview={preview.data} />
      <FullText text={preview.data.text} />
    </>
  )
}

/**
 * The effective prompt as an inline panel: exactly what one task of a repository gets from saved
 * text, with the 12k budget, Copy text, and Ask in chat (a new thread with the repository as
 * context). Blocks, Full text and Warnings are underline tabs.
 */
export function EffectivePromptPanel({
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
  const [view, setView] = useState<'blocks' | 'text' | 'warnings'>('blocks')
  const preview = useGuidePreview(repo, task)
  const { create } = useChatMutations()
  const navigate = useNavigate()
  const taskLabel = guideTasks.find((t) => t.id === task)?.label ?? task

  const ask = () =>
    repo &&
    create.mutate(
      {
        title: `Guide of ${repo.path} for ${taskLabel.toLowerCase()}`,
        contextRepos: [repoKey(repo)],
      },
      {
        onSuccess: (thread) => void navigate({ to: '/chat', search: { thread: thread.id } }),
        onError: (error) => notify.error('Thread not created', messageOf(error)),
      },
    )

  return (
    <section
      aria-label="Effective prompt"
      className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">Effective prompt</h2>
          <p className="text-xs text-muted">
            Exactly what one task in this repository receives. Saved text only: unsaved edits are
            not included.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label="Close effective prompt"
          onPress={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Repository"
          options={repos.map((key) => ({ id: key, label: key }))}
          value={repo ? repoKey(repo) : undefined}
          onChange={(key) => setRepo(parseRepoKey(key))}
          placeholder="Choose a repository"
          className="min-w-56"
        />
        <Segmented aria-label="Task" options={guideTasks} value={task} onChange={setTask} />
      </div>
      {!repo ? (
        <p className="text-sm text-muted">Choose a repository to see what its tasks get.</p>
      ) : preview.isPending ? (
        <Placeholder className="h-48" />
      ) : preview.isError ? (
        <ErrorState error={preview.error} />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <BudgetBar budget={preview.data.budget} />
            </div>
            <div className="flex gap-2">
              <CopyButton text={() => preview.data.text} isDisabled={!preview.data.text}>
                Copy text
              </CopyButton>
              <Button variant="secondary" size="sm" isPending={create.isPending} onPress={ask}>
                <MessageSquare className="size-3.5" />
                Ask in chat
              </Button>
            </div>
          </div>
          <UnderlineTabs
            aria-label="Effective prompt views"
            items={[
              { id: 'blocks', label: 'Blocks', badge: preview.data.blocks.length },
              { id: 'text', label: 'Full text' },
              { id: 'warnings', label: 'Warnings', badge: preview.data.warnings.length },
            ]}
            selected={view}
            onSelect={(id) => setView(id === 'text' || id === 'warnings' ? id : 'blocks')}
          />
          {view === 'blocks' ? <Blocks preview={preview.data} /> : null}
          {view === 'text' ? <FullText text={preview.data.text} /> : null}
          {view === 'warnings' ? (
            preview.data.warnings.length ? (
              <Warnings warnings={preview.data.warnings} />
            ) : (
              <p className="text-sm text-muted">No warnings.</p>
            )
          ) : null}
        </>
      )}
    </section>
  )
}
