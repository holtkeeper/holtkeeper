import { Cron } from 'croner'

/** The problem with a cron expression, or `undefined` when croner accepts it. */
export function cronError(expression: string): string | undefined {
  try {
    new Cron(expression, { paused: true }).stop()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** First run strictly after `after`, or `undefined` when the expression never fires again. */
export function nextRun(expression: string, after: Date, timezone?: string): Date | undefined {
  const cron = new Cron(expression, { paused: true, ...(timezone ? { timezone } : {}) })
  return cron.nextRun(after) ?? undefined
}
