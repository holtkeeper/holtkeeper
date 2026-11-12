import type { FixAttempt } from '@holtkeeper/api'
import { CircleAlert, CircleCheck, CircleDashed, FileCode2, Wrench } from 'lucide-react'

import { fixChains } from '../../lib/fixes.ts'
import { plural } from '../../lib/format.ts'
import { EmptyState, Tag } from '../../ui/index.ts'

function AttemptIcon({ attempt }: { attempt: FixAttempt }) {
  if (attempt.error) return <CircleAlert className="size-4 text-bad" />
  if (attempt.fixed.length) return <CircleCheck className="size-4 text-ok" />
  return <CircleDashed className="size-4 text-muted" />
}

/** Per source file, the chain of fixers that ran, what each was handed and what it claimed. */
export function FixTimeline({ fixes }: { fixes: readonly FixAttempt[] }) {
  const chains = fixChains(fixes)
  if (chains.length === 0) {
    return (
      <EmptyState
        icon={<Wrench />}
        title="No fix attempts"
        description="The run reported only, or nothing was fixable."
      />
    )
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {chains.map((chain) => (
        <section
          key={chain.source}
          aria-label={`Fixes for ${chain.source}`}
          className="rounded-xl border border-line bg-panel p-3.5"
        >
          <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 mono text-[12.5px]">
              <FileCode2 className="size-4 shrink-0 text-muted" />
              <span className="truncate">{chain.source}</span>
            </span>
            <span className="flex items-center gap-2">
              <Tag
                tone={
                  chain.fixed >= chain.requested ? 'success' : chain.fixed ? 'warning' : 'default'
                }
                dot
              >
                {chain.fixed}/{chain.requested} claimed fixed
              </Tag>
              {chain.failed ? (
                <Tag tone="danger" dot>
                  Error
                </Tag>
              ) : null}
            </span>
          </header>
          <ol className="relative flex flex-col gap-4 border-l border-line pl-5">
            {chain.attempts.map((attempt, index) => (
              <li key={`${attempt.fixer}-${index}`} className="relative">
                <span className="absolute -left-[1.8rem] top-0 grid size-6 place-items-center rounded-full border border-line bg-panel">
                  <AttemptIcon attempt={attempt} />
                </span>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">{attempt.fixer}</span>
                  <span className="text-xs text-muted">
                    handed {plural(attempt.requested.length, 'finding')} · claimed{' '}
                    {attempt.fixed.length}
                  </span>
                </div>
                {attempt.changedFiles.length ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {attempt.changedFiles.map((file) => (
                      <span key={file} className="rounded bg-raise px-1.5 py-0.5 mono text-[11px]">
                        {file}
                      </span>
                    ))}
                  </div>
                ) : null}
                {attempt.notes.length ? (
                  <ul className="mt-1.5 list-disc pl-4 text-xs text-muted">
                    {attempt.notes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                ) : null}
                {attempt.error ? (
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-line bg-raise p-2 mono text-[11px] text-bad">
                    {attempt.error}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}
