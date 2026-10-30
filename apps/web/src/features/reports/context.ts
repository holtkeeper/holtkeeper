import { createContext } from 'react'

/** What blocks may do with the report they are part of; absent when shown read-only. */
export interface ReportActions {
  analysisId: string
  /** Whether the principal may accept proposed changes (`analyses:run`). */
  canApply: boolean
}

export const ReportContext = createContext<ReportActions | null>(null)
