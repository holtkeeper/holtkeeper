import type { CommandRunner } from '@holtkeeper/exec'
import type { CoverageSummary } from '@holtkeeper/quality'

/** Test frameworks the check recognizes. */
export type TestFramework =
  | 'bun:test'
  | 'vitest'
  | 'jest'
  | 'mocha'
  | 'node:test'
  | 'go test'
  | 'pytest'

/** Source language family a framework tests. */
export type TestLanguage = 'js' | 'go' | 'python'

/**
 * Where a project keeps its tests:
 * - `colocated` — next to the source (`src/a.test.ts`, `pkg/a_test.go`)
 * - `__tests__` — in a `__tests__` folder next to the source (`src/__tests__/a.test.ts`)
 * - `test-dir` — in a top-level `test/` or `tests/` folder of the package (`test/a.test.ts`, `tests/test_a.py`)
 */
export type TestLayout = 'colocated' | '__tests__' | 'test-dir'

/** How test files are written in one language of the project, learned from existing tests. */
export interface TestConventions {
  language: TestLanguage
  layout: TestLayout
  /** Folder name for `test-dir` layout (`test` or `tests`) and `__tests__`. */
  testDir?: string
  /**
   * File name template; `{name}` is the source file name without extension, e.g.
   * `{name}.test.ts`, `{name}.spec.js`, `{name}_test.go`, `test_{name}.py`.
   */
  fileName: string
  /** Most common import of the framework in existing tests, e.g. `import { expect, test } from 'bun:test'`. */
  frameworkImport?: string
  /** How tests import local modules: `./a.ts`, `./a.js` or `./a`. */
  localImportExtension?: '.ts' | '.js' | 'none'
}

/** One framework found in the project and the evidence for it. */
export interface DetectedFramework {
  framework: TestFramework
  language: TestLanguage
  /** Human-readable signals, e.g. `package.json devDependencies: vitest`, `3 tests import vitest`. */
  evidence: string[]
}

/**
 * What a project tests with and how. `frameworks` is ordered by confidence; the first one per
 * language is the one new tests should use.
 */
export interface TestSetup {
  frameworks: DetectedFramework[]
  /** Conventions per language that has tests or a framework. */
  conventions: TestConventions[]
  /** Up to three existing test files (relative paths) worth imitating, best first. */
  samples: string[]
  /** Number of existing test files found. */
  testFiles: number
}

/** Execution counts of one line. */
export interface LineHit {
  line: number
  hits: number
}

/** A function the coverage tool knows about. */
export interface FunctionHit {
  name: string
  /** First line of the function. */
  line: number
  /** Last line, when the tool reports it (lcov 2 `FN:start,end,name`). */
  endLine?: number
  hits: number
}

/** One branch outcome (lcov `BRDA`). `taken` is `undefined` when the branch's block never ran. */
export interface BranchHit {
  line: number
  block: string
  branch: string
  taken?: number
}

/** Coverage of one file. */
export interface FileCoverage {
  /** Relative to the analyzed directory, `/`-separated. */
  file: string
  lines: LineHit[]
  functions: FunctionHit[]
  branches: BranchHit[]
}

/** Coverage of a project in one shape, whatever tool produced it. */
export interface CoverageReport {
  format: 'lcov' | 'go'
  /** Languages the report judges; source files of other languages are not ranked against it. */
  languages: TestLanguage[]
  files: FileCoverage[]
  summary: CoverageSummary
}

export interface CoverageContext {
  dir: string
  runner: CommandRunner
  signal?: AbortSignal
}

/**
 * Produces coverage for a project: by running its tests with coverage, or by reading a report
 * that already exists. Implementations are replaceable per tool.
 */
export interface CoverageCollector {
  readonly name: string
  collect(context: CoverageContext): Promise<CoverageReport>
}
