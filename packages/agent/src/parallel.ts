/**
 * Runs `work` on every item with at most `limit` running at once and settles each like
 * `Promise.allSettled`, results in item order. Once `signal` aborts no further item starts and the
 * call rejects with the abort reason after the running ones finish.
 */
export async function settledInParallel<Item, Result>(
  items: readonly Item[],
  limit: number,
  signal: AbortSignal | undefined,
  work: (item: Item, index: number) => Promise<Result>,
): Promise<PromiseSettledResult<Result>[]> {
  const results: PromiseSettledResult<Result>[] = []
  const queue = [...items.entries()]
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      if (signal?.aborted) return
      const [index, item] = entry
      try {
        // oxlint-disable-next-line no-await-in-loop -- a worker takes one item at a time
        results[index] = { status: 'fulfilled', value: await work(item, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  signal?.throwIfAborted()
  return results
}
