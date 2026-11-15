type Operation = { kind: 'keep' | 'remove' | 'add'; text: string }

/** Largest `before × after` line product `unifiedDiff` works on; cases are small files. */
const MAX_CELLS = 4_000_000

const linesOf = (text: string) => {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Line operations turning `before` into `after`, from the longest common subsequence. */
function operations(before: readonly string[], after: readonly string[]): Operation[] {
  if (before.length * after.length > MAX_CELLS)
    throw new Error('files too large to diff for an eval case')
  const width = after.length + 1
  const common = new Uint32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      common[i * width + j] =
        before[i] === after[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0)
  const result: Operation[] = []
  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      result.push({ kind: 'keep', text: before[i] ?? '' })
      i++
      j++
    } else if (
      j >= after.length ||
      (i < before.length && (common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0))
    ) {
      result.push({ kind: 'remove', text: before[i] ?? '' })
      i++
    } else {
      result.push({ kind: 'add', text: after[j] ?? '' })
      j++
    }
  }
  return result
}

/**
 * The hunks of a unified diff from `before` to `after` (the body forges return per file: `@@`
 * headers and lines, no file headers), with `context` unchanged lines around each change. Empty
 * when the texts are equal. A new file has `before` `''` and one hunk `@@ -0,0 +1,n @@`.
 */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const steps = operations(linesOf(before), linesOf(after))
  const changed = steps.flatMap((step, index) => (step.kind === 'keep' ? [] : [index]))
  if (changed.length === 0) return ''

  // Changes closer than two contexts share a hunk.
  const ranges: [number, number][] = []
  for (const index of changed) {
    const from = Math.max(0, index - context)
    const to = Math.min(steps.length - 1, index + context)
    const last = ranges.at(-1)
    if (last && from <= last[1] + 1) last[1] = to
    else ranges.push([from, to])
  }

  // Old and new line numbers of the step at each index (1-based, of the line it would be).
  const oldAt: number[] = []
  const newAt: number[] = []
  let oldLine = 1
  let newLine = 1
  for (const step of steps) {
    oldAt.push(oldLine)
    newAt.push(newLine)
    if (step.kind !== 'add') oldLine++
    if (step.kind !== 'remove') newLine++
  }

  return ranges
    .map(([from, to]) => {
      const body = steps.slice(from, to + 1)
      const oldCount = body.filter((step) => step.kind !== 'add').length
      const newCount = body.filter((step) => step.kind !== 'remove').length
      // An empty side is numbered by the line before it, as `diff -u` does.
      const oldStart = oldCount ? (oldAt[from] ?? 1) : (oldAt[from] ?? 1) - 1
      const newStart = newCount ? (newAt[from] ?? 1) : (newAt[from] ?? 1) - 1
      const marks = { keep: ' ', remove: '-', add: '+' }
      return [
        `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
        ...body.map((step) => `${marks[step.kind]}${step.text}`),
      ].join('\n')
    })
    .join('\n')
    .concat('\n')
}
