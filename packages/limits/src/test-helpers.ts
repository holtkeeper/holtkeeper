/** Resolves with what `promise` rejected with, or `undefined` when it fulfilled. */
export const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )
