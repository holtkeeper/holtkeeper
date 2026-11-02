/**
 * The HTTP status a forge answered with, when `error` came from a forge client: adapters throw
 * errors that carry it as a numeric `status`. `undefined` for anything else (network failures,
 * bugs).
 */
export function forgeErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined
  return typeof error.status === 'number' ? error.status : undefined
}
