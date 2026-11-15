import type { EvalCase, ExpectedFinding } from '../case.ts'

/** An expected problem located by the text of its lines instead of their numbers. */
interface Problem extends Omit<ExpectedFinding, 'lines'> {
  /**
   * Text of the problem's first line through its last (a multi-line snippet covers several), as it
   * appears exactly once in the file's `after` version.
   */
  find: string
}

/** An `EvalCase` whose expected problems are `Problem`s. */
export interface CaseSpec extends Omit<EvalCase, 'expected'> {
  problems?: readonly Problem[]
}

/** New-side line numbers `[from, to]` of `snippet` in `text`; throws unless it occurs exactly once. */
export function locate(text: string, snippet: string): [number, number] {
  const at = text.indexOf(snippet)
  if (at < 0 || text.indexOf(snippet, at + 1) >= 0)
    throw new Error(`snippet must occur exactly once: ${JSON.stringify(snippet)}`)
  const from = text.slice(0, at).split('\n').length
  return [from, from + snippet.split('\n').length - 1]
}

/** Builds the case, turning every problem's `find` into line numbers of the changed file. */
export function defineCase(spec: CaseSpec): EvalCase {
  const { problems = [], ...rest } = spec
  return {
    ...rest,
    expected: problems.map(({ find, ...problem }) => {
      const after = spec.changes[problem.path]?.after
      if (after === undefined) throw new Error(`${spec.id}: ${problem.path} has no after version`)
      return { ...problem, lines: locate(after, find) }
    }),
  }
}
