import type { CredentialService } from './service.ts'
import type { RotationResult } from './types.ts'

export interface RotationScheduleOptions {
  /** Time between runs. Default one hour. */
  intervalMs?: number
  /** Called after every run with its results, e.g. for logging. */
  onResults?: (results: RotationResult[]) => void
  /** Called when a whole run fails, e.g. the store is unreachable. */
  onError?: (error: unknown) => void
}

/**
 * Runs `service.rotateDue()` now and then every `intervalMs`. A run is skipped while the previous one
 * is still going. Nothing thrown by a run or by the callbacks escapes the timer.
 * Returns a function that stops the schedule; a run already in progress finishes.
 */
export function startRotationSchedule(
  service: Pick<CredentialService, 'rotateDue'>,
  { intervalMs = 3_600_000, onResults, onError }: RotationScheduleOptions = {},
): () => void {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      const results = await service.rotateDue()
      try {
        onResults?.(results)
      } catch {}
    } catch (error) {
      try {
        onError?.(error)
      } catch {}
    } finally {
      running = false
    }
  }

  void run()
  const timer = setInterval(() => void run(), intervalMs)
  return () => clearInterval(timer)
}
