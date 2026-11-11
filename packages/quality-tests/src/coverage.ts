import { collectorFor, coverageFileCollector, mergeReports } from './collect.ts'
import { detectTestSetup } from './detect.ts'
import type {
  CoverageCollector,
  CoverageContext,
  CoverageReport,
  TestFramework,
  TestLanguage,
  TestSetup,
} from './types.ts'

function primaryFrameworks(setup: TestSetup): Partial<Record<TestLanguage, TestFramework>> {
  const primary: Partial<Record<TestLanguage, TestFramework>> = {}
  for (const entry of setup.frameworks) primary[entry.language] ??= entry.framework
  return primary
}

/**
 * Runs `collectors` one after another and merges what they produced; `tools` names the ones that
 * did. A failing collector is skipped; throws only when none produced a report, with every
 * collector's error.
 */
export async function collectCoverage(
  collectors: readonly CoverageCollector[],
  context: CoverageContext,
): Promise<CoverageReport & { tools: string[] }> {
  const reports: CoverageReport[] = []
  const tools: string[] = []
  const errors: string[] = []
  for (const collector of collectors) {
    try {
      // Sequential: collectors run whole test suites in the same checkout.
      // oxlint-disable-next-line no-await-in-loop
      const report = await collector.collect(context)
      reports.push(report)
      tools.push(collector.name)
    } catch (error) {
      context.signal?.throwIfAborted()
      errors.push(`${collector.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!reports.length)
    throw new Error(errors.join('\n') || 'no coverage collector applies to this project')
  return { ...mergeReports(reports), tools }
}

/**
 * The collectors for a project: one per language with the language's primary framework, or a
 * reader of `coverage.file` when given.
 */
export async function coverageCollectors(
  dir: string,
  coverage: 'run' | { file: string } = 'run',
): Promise<CoverageCollector[]> {
  if (typeof coverage === 'object') return [coverageFileCollector(coverage.file)]
  const frameworks = primaryFrameworks(await detectTestSetup(dir))
  return Object.values(frameworks).map((framework) => collectorFor(framework, dir))
}
