import type { FixAttempt } from '@holtkeeper/api'
import { CircleAlert, CircleCheck, CircleDashed, FileCode2, Wrench } from 'lucide-react'
import { motion } from 'motion/react'

import { fixChains } from '../../lib/fixes.ts'
import { plural } from '../../lib/format.ts'
import { Chip, EmptyState, fadeItem, stagger } from '../../ui/index.ts'

function AttemptIcon({ attempt }: { attempt: FixAttempt }) {
  if (attempt.error) return <CircleAlert className="size-4 text-danger" />
  if (attempt.fixed.length) return <CircleCheck className="size-4 text-success" />
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
    <motion.div {...stagger} className="grid gap-4 lg:grid-cols-2">
      {chains.map((chain) => (
        <motion.section
          key={chain.source}
          {...fadeItem}
          aria-label={`Fixes for ${chain.source}`}
          className="rounded-2xl border border-border bg-surface p-4 shadow-surface"
        >
          <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 font-mono text-[13px]">
              <FileCode2 className="size-4 shrink-0 text-muted" />
              <span className="truncate">{chain.source}</span>
            </span>
            <span className="flex items-center gap-2">
              <Chip
                tone={
                  chain.fixed >= chain.requested ? 'success' : chain.fixed ? 'warning' : 'default'
                }
              >
                {chain.fixed}/{chain.requested} claimed fixed
              </Chip>
              {chain.failed ? <Chip tone="danger">error</Chip> : null}
            </span>
          </header>
          <ol className="relative flex flex-col gap-4 border-l border-separator pl-5">
            {chain.attempts.map((attempt, index) => (
              <li key={`${attempt.fixer}-${index}`} className="relative">
                <span className="absolute -left-[1.8rem] top-0 grid size-6 place-items-center rounded-full border border-border bg-surface">
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
                      <span
                        key={file}
                        className="rounded-md bg-default px-1.5 py-0.5 font-mono text-[11px]"
                      >
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
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-danger-soft p-2 font-mono text-[11px] text-danger-soft-foreground">
                    {attempt.error}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        </motion.section>
      ))}
    </motion.div>
  )
}
