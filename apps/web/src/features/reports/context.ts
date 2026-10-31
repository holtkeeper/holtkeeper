import type { RepoRef, ReportExclude } from '@holtkeeper/api'
import { createContext } from 'react'

/** What blocks may do with the report they are part of; absent when shown read-only. */
export interface ReportActions {
  analysisId: string
  /** Whether the principal may accept proposed changes (`analyses:run`). */
  canApply: boolean
  /** Set when files of the report can be excluded from later runs of its repository. */
  exclude?: { repo: RepoRef } & ReportExclude
}

export const ReportContext = createContext<ReportActions | null>(null)
