import type { JobLogLine } from '@holtkeeper/api'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import { useJobLog } from '../../api/queries.ts'
import { formatDuration } from '../../lib/format.ts'
import { logLineTime } from '../../lib/jobs.ts'
import { Button, ErrorState, Placeholder, notify } from '../../ui/index.ts'

/** Lines of an attempt's tail the detail loads; the steps timeline shares this query. */
export const LOG_TAIL = 1000

/** The log of one job attempt: its last lines with step marks, following new ones while `live`. */
export function JobLogView({
  jobId,
  attempt,
  live,
}: {
  jobId: string
  attempt: number
  live: boolean
}) {
  const log = useJobLog(jobId, attempt, live, LOG_TAIL)
  const client = useQueryClient()
  const [earlier, setEarlier] = useState<JobLogLine[]>([])
  const [loading, setLoading] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const tail = log.data?.lines ?? []
  const tailStart = tail[0]?.n ?? Number.POSITIVE_INFINITY
  const lines = [...earlier.filter((line) => line.n < tailStart), ...tail]
  const first = lines[0]?.n ?? 0

  useEffect(() => {
    const element = box.current
    if (element && follow.current) element.scrollTop = element.scrollHeight
  }, [log.data?.total])

  if (attempt === 0) return <p className="text-xs text-muted">The job has not started yet.</p>
  if (log.isPending) return <Placeholder className="h-48" />
  if (log.isError) return <ErrorState error={log.error} />
  if (!lines.length) return <p className="text-xs text-muted">No log lines yet.</p>

  const loadEarlier = async () => {
    setLoading(true)
    try {
      const offset = Math.max(0, first - LOG_TAIL)
      const page = await client.fetchQuery({
        queryKey: ['jobs', 'log-page', jobId, attempt, offset],
        queryFn: () => api.jobLog(jobId, { attempt, offset, limit: first - offset }),
      })
      setEarlier((previous) => [...page.lines, ...previous])
      follow.current = false
    } catch (error) {
      notify.error('Earlier lines not loaded', messageOf(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {first > 0 ? (
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="tabular">
            {first} earlier line{first === 1 ? '' : 's'} of {log.data?.total ?? 0}
          </span>
          <Button size="sm" variant="ghost" isPending={loading} onPress={() => void loadEarlier()}>
            Show earlier
          </Button>
        </div>
      ) : null}
      <div
        ref={box}
        role="log"
        onScroll={(event) => {
          const element = event.currentTarget
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
        }}
        className="max-h-[32rem] overflow-auto rounded-[7px] border border-line bg-sunk px-3 py-2 font-mono text-[11.5px] leading-relaxed"
      >
        {lines.map((line) => (
          <LogLine key={line.n} line={line} />
        ))}
      </div>
    </div>
  )
}

function LogLine({ line }: { line: JobLogLine }) {
  const time = <span className="w-16 shrink-0 text-dim tabular">{logLineTime(line.at)}</span>
  if (line.mark) {
    const tone = line.mark === 'fail' ? 'text-bad' : line.mark === 'end' ? 'text-ok' : 'text-info'
    const symbol = line.mark === 'start' ? '▸' : line.mark === 'end' ? '✓' : '✗'
    return (
      <div className={`mt-1 flex gap-3 font-medium first:mt-0 ${tone}`}>
        {time}
        <span className="min-w-0 break-words">
          {symbol} {line.mark === 'fail' ? line.text : line.step}
          {line.ms !== undefined ? (
            <span className="ml-2 font-normal text-muted">{formatDuration(line.ms)}</span>
          ) : null}
        </span>
      </div>
    )
  }
  return (
    <div className={`flex gap-3 ${line.level === 'error' ? 'text-bad' : ''}`}>
      {time}
      <span className={`min-w-0 whitespace-pre-wrap break-words ${line.step ? 'pl-3' : ''}`}>
        {line.text}
      </span>
    </div>
  )
}
