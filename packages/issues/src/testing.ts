import type { Issue, IssueDetails, IssueTracker } from './index.ts'

/**
 * An in-memory `IssueTracker` for tests: knows `issues`, records each call's keys, fails on
 * demand. With `details` it also answers `issue(key)` from them (`undefined` for other keys).
 */
export function fakeIssueTracker(
  issues: readonly Issue[],
  options: { fail?: Error; details?: readonly IssueDetails[] } = {},
): IssueTracker & { calls: string[][] } {
  const calls: string[][] = []
  const { details } = options
  return {
    provider: 'fake',
    calls,
    async issues(keys) {
      calls.push([...keys])
      if (options.fail) throw options.fail
      return issues.filter((issue) => keys.includes(issue.key))
    },
    ...(details && {
      async issue(key: string) {
        calls.push([key])
        if (options.fail) throw options.fail
        return details.find((issue) => issue.key === key)
      },
    }),
  }
}
