import type { Toolset } from '@holtkeeper/agent'

import { type Budget, budgetOf } from '../budget.ts'
import { graphTools, type ModuleGraphLoader } from './graph.ts'
import { readTool } from './read.ts'
import { grepTool, searchTool } from './search.ts'
import { outlineTool, referencesTool, symbolTool } from './symbols.ts'

export { cachedModuleGraph, jsModuleGraph } from './graph.ts'
export type { ModuleGraphLoader, ModuleIndex } from './graph.ts'
export { LANGUAGES, type LanguageName } from './syntax.ts'

export interface CodeToolsOptions {
  budget?: Partial<Budget>
  /** Import graph for `code.dependents`/`code.dependencies`; default `jsModuleGraph`. */
  moduleGraph?: ModuleGraphLoader
}

/**
 * The `code` toolset: `code.search`, `code.grep`, `code.outline`, `code.symbol`,
 * `code.references`, `code.read`, `code.dependents`, `code.dependencies`. Every tool is confined
 * to the task directory and stays within the budget. The module graph is built on first use and
 * cached for the lifetime of the toolset, so build one toolset per run.
 */
export function codeTools(options: CodeToolsOptions = {}): Toolset {
  const budget = budgetOf(options.budget)
  return {
    name: 'code',
    tools: [
      searchTool(budget),
      grepTool(budget),
      outlineTool(budget),
      symbolTool(budget),
      referencesTool(budget),
      readTool(budget),
      ...graphTools(budget, options.moduleGraph),
    ],
  }
}
