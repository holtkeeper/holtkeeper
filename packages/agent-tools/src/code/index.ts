import type { Toolset } from '@holtkeeper/agent'

import { type Budget, budgetOf } from '../budget.ts'
import { importsTool, type ModuleGraphLoader } from './graph.ts'
import { readTool } from './read.ts'
import { grepTool, searchTool } from './search.ts'
import { outlineTool, symbolTool } from './symbols.ts'

export { cachedModuleGraph, jsModuleGraph } from './graph.ts'
export type { ModuleGraphLoader, ModuleIndex } from './graph.ts'
export { LANGUAGES, type LanguageName } from './syntax.ts'

export interface CodeToolsOptions {
  budget?: Partial<Budget>
  /** Import graph for `code.imports`; default `jsModuleGraph`. */
  moduleGraph?: ModuleGraphLoader
  /**
   * Whether `code.grep` and `code.read` are part of the toolset (default). Pass `false` for an
   * agent that already has file tools of its own, so it does not get two of each.
   */
  files?: boolean
}

/**
 * The `code` toolset: `code.search`, `code.outline`, `code.symbol`, `code.imports` and, unless
 * `files` is `false`, `code.grep` and `code.read`. Every tool is confined to the task directory
 * and stays within the budget. The module graph is built on first use and cached for the
 * lifetime of the toolset, so build one toolset per run.
 */
export function codeTools(options: CodeToolsOptions = {}): Toolset {
  const budget = budgetOf(options.budget)
  const files = options.files ?? true
  return {
    name: 'code',
    tools: [
      searchTool(budget),
      ...(files ? [grepTool(budget)] : []),
      outlineTool(budget),
      symbolTool(budget),
      ...(files ? [readTool(budget)] : []),
      importsTool(budget, options.moduleGraph),
    ],
  }
}
