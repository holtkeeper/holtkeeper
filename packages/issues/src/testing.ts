import type { Issue, IssueTracker } from './index.ts'

/** An in-memory `IssueTracker` for tests: knows `issues`, records each call's keys, fails on demand. */
export function fakeIssueTracker(
  issues: readonly Issue[],
  options: { fail?: Error } = {},
): IssueTracker & { calls: string[][] } {
  const calls: string[][] = []
  return {
    provider: 'fake',
    calls,
    async issues(keys) {
      calls.push([...keys])
      if (options.fail) throw options.fail
      return issues.filter((issue) => keys.includes(issue.key))
    },
  }
}
