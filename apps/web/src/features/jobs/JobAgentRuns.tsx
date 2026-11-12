import type { AgentTranscriptView, AiUsageRecord } from '@holtkeeper/api'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { useJobRuns, useJobTranscript } from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { formatDuration } from '../../lib/format.ts'
import { ErrorState, Placeholder, Tag } from '../../ui/index.ts'

type Line = AgentTranscriptView['lines'][number]

function TranscriptLine({ line }: { line: Line }) {
  switch (line.type) {
    case 'start':
      return (
        <details className="rounded-[7px] border border-line bg-sunk px-2 py-1.5">
          <summary className="cursor-pointer text-[11px] text-muted">
            <span className="mono">{line.model}</span> · {line.runtime} · tier {line.tier} ·{' '}
            {line.tools.length} tools · prompt
          </summary>
          <pre className="mt-1.5 max-h-60 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted">
            {line.prompt}
          </pre>
        </details>
      )
    case 'assistant':
      return (
        <div className="flex flex-col gap-1">
          {line.text ? <p className="text-xs whitespace-pre-wrap">{line.text}</p> : null}
          {(line.toolCalls ?? []).map((call) => (
            <div key={call.id} className="flex min-w-0 items-center gap-2">
              <Tag mono tone="code">
                {call.name}
              </Tag>
              <code className="truncate text-[11px] text-muted">
                {typeof call.input === 'string' ? call.input : JSON.stringify(call.input)}
              </code>
            </div>
          ))}
        </div>
      )
    case 'tool-result':
      return (
        <pre
          className={`max-h-40 overflow-auto rounded-[7px] border border-line bg-sunk px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap ${line.isError ? 'text-bad' : 'text-muted'}`}
        >
          {line.output}
        </pre>
      )
    default:
      return (
        <p className={`text-[11px] ${line.outcome === 'ok' ? 'text-muted' : 'text-bad'}`}>
          Ended {line.outcome}
          {line.turns !== undefined ? ` after ${line.turns} turns` : ''}
          {line.costUsd !== undefined ? ` · ${formatUsd(line.costUsd)}` : ''}
          {line.error ? ` · ${line.error}` : ''}
        </p>
      )
  }
}

function Transcript({ jobId, transcriptRef }: { jobId: string; transcriptRef: string }) {
  const transcript = useJobTranscript(jobId, transcriptRef)
  if (transcript.isPending) return <Placeholder className="h-24" />
  if (transcript.isError) return <ErrorState error={transcript.error} />
  return (
    <ol className="flex flex-col gap-2 border-l border-line pl-3">
      {transcript.data.lines.map((line, index) => (
        <li key={index}>
          <TranscriptLine line={line} />
        </li>
      ))}
    </ol>
  )
}

function Run({ jobId, run }: { jobId: string; run: AiUsageRecord }) {
  const [open, setOpen] = useState(false)
  const ref = run.transcriptRef
  return (
    <li className="flex flex-col gap-2 border-b border-line py-2 last:border-b-0">
      <button
        type="button"
        disabled={ref === undefined}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-w-0 items-center gap-2 text-left text-xs disabled:cursor-default"
      >
        <ChevronRight
          aria-hidden
          className={`size-3 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''} ${ref === undefined ? 'invisible' : ''}`}
        />
        <span className="font-medium">{run.taskKind}</span>
        <span className="mono truncate text-muted">{run.model}</span>
        {run.outcome === 'ok' ? null : (
          <Tag tone={run.outcome === 'denied-budget' ? 'warning' : 'danger'}>
            {run.outcome === 'denied-budget' ? 'denied by budget' : 'error'}
          </Tag>
        )}
        <span className="ml-auto mono shrink-0 text-muted tabular">
          {(run.inputTokens + run.cacheReadTokens + run.cacheWriteTokens).toLocaleString()} in ·{' '}
          {run.outputTokens.toLocaleString()} out · {run.turns} turns ·{' '}
          {formatDuration(run.durationMs)}
        </span>
        <span className="mono w-14 shrink-0 text-right tabular">{formatUsd(run.costUsd)}</span>
      </button>
      {open && ref !== undefined ? <Transcript jobId={jobId} transcriptRef={ref} /> : null}
    </li>
  )
}

/**
 * The agent runs of a job with what they cost, each opening its transcript (model messages, tool
 * calls and results); nothing renders for jobs without agent runs.
 */
export function JobAgentRuns({ jobId, live }: { jobId: string; live: boolean }) {
  const runs = useJobRuns(jobId, live)
  if (runs.isPending || runs.isError || runs.data.runs.length === 0) return null
  return (
    <section className="flex flex-col gap-1">
      <h3 className="flex items-baseline gap-2 text-xs font-medium text-muted">
        Agent runs
        <span className="mono text-foreground">{formatUsd(runs.data.costUsd)}</span>
      </h3>
      <ul>
        {runs.data.runs.map((run) => (
          <Run key={run.id} jobId={jobId} run={run} />
        ))}
      </ul>
    </section>
  )
}
