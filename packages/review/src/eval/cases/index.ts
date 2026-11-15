import type { EvalCase } from '../case.ts'
import { cleanCases } from './clean.ts'
import { crossFileCases } from './cross-file.ts'
import { goCases } from './go.ts'
import { logicCases } from './logic.ts'
import { securityCases } from './security.ts'

/**
 * The golden set: small invented merge requests, with the problems a careful reviewer should find
 * and changes it should leave alone. Add a case whenever a review misses a kind of problem or
 * comments on a kind of change it should not; invent its names, never copy real code.
 */
export const goldenCases: readonly EvalCase[] = [
  ...logicCases,
  ...securityCases,
  ...goCases,
  ...crossFileCases,
  ...cleanCases,
]
