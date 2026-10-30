import type { QualityCheck, QualityContext, QualityResult } from '@holtkeeper/quality'

import { collectChurn, collectorFor, coverageFileCollector, mergeReports } from './collect.ts'
import { detectTestSetup } from './detect.ts'
import { writeExampleTests } from './examples.ts'
import { rankTestTargets } from './rank.ts'
import type {
  CoverageCollector,
  CoverageReport,
  TestFramework,
  TestLanguage,
  TestSetup,
} from './types.ts'

export interface TestGapsOptions {
  /** `'run'` (default) runs the project's tests with coverage; `{ file }` reads an existing lcov or Go profile. */
  coverage?: 'run' | { file: string }
  /** Collectors to use instead of the ones derived from `coverage` and the detected frameworks. */
  collectors?: readonly CoverageCollector[]
  /** Suggestions to report. Default 10. */
  top?: number
  /** How many top suggestions get an agent-written example test. Default 3; 0 disables. */
  examples?: number
  /** Let the agent run each new test once before answering. Default false. */
  verify?: boolean
  /** Churn window in days. Default 90. */
  churnDays?: number
}

/** The best framework per language, which is also the one whose coverage is collected. */
function primaryFrameworks(setup: TestSetup): Partial<Record<TestLanguage, TestFramework>> {
  const primary: Partial<Record<TestLanguage, TestFramework>> = {}
  for (const entry of setup.frameworks) primary[entry.language] ??= entry.framework
  return primary
}

async function collect(
  collectors: readonly CoverageCollector[],
  context: QualityContext,
): Promise<CoverageReport> {
  const reports: CoverageReport[] = []
  const errors: string[] = []
  for (const collector of collectors) {
    try {
      // Sequential: collectors run whole test suites in the same checkout.
      // oxlint-disable-next-line no-await-in-loop
      const report = await collector.collect({
        dir: context.dir,
        runner: context.runner,
        ...(context.signal ? { signal: context.signal } : {}),
      })
      reports.push(report)
    } catch (error) {
      context.signal?.throwIfAborted()
      errors.push(`${collector.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!reports.length)
    throw new Error(errors.join('\n') || 'no coverage collector applies to this project')
  return mergeReports(reports)
}

/**
 * Quality check `tests`: collects coverage, ranks untested or weakly tested functions by size,
 * branches and churn into `tests` suggestions, reports the `coverage` summary, and — when the
 * context has an agent — attaches an example test as a `review` change to the top suggestions.
 * Applies to projects with a detected test framework, or whenever a coverage file is given.
 */
export function testGapsCheck(options: TestGapsOptions = {}): QualityCheck {
  return {
    name: 'tests',
    async detect(dir) {
      if (options.collectors?.length || typeof options.coverage === 'object') return true
      return (await detectTestSetup(dir)).frameworks.length > 0
    },
    async run(context): Promise<QualityResult> {
      const setup = await detectTestSetup(context.dir)
      const frameworks = primaryFrameworks(setup)
      const collectors =
        options.collectors ??
        (typeof options.coverage === 'object'
          ? [coverageFileCollector(options.coverage.file)]
          : Object.values(frameworks).map((framework) => collectorFor(framework, context.dir)))
      const coverage = await collect(collectors, context)
      context.signal?.throwIfAborted()

      const churnDays = options.churnDays ?? 90
      const churn = await collectChurn({
        dir: context.dir,
        runner: context.runner,
        days: churnDays,
        ...(context.signal ? { signal: context.signal } : {}),
      })
      let tests = await rankTestTargets({
        dir: context.dir,
        coverage,
        churn,
        churnDays,
        frameworks,
        top: options.top ?? 10,
      })

      const examples = options.examples ?? 3
      if (!context.agent || examples <= 0 || !tests.length)
        return { tests, coverage: coverage.summary, changes: [] }
      const written = await writeExampleTests({
        dir: context.dir,
        agent: context.agent,
        setup,
        suggestions: tests,
        count: examples,
        verify: options.verify ?? false,
        ...(context.signal ? { signal: context.signal } : {}),
      })
      tests = written.suggestions
      return { tests, coverage: coverage.summary, changes: written.changes }
    },
  }
}
