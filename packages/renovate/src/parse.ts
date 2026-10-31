import { z } from 'zod'

import {
  type RenovateDeprecation,
  type RenovateProblem,
  type RenovateUpdate,
  type RenovateUpdateType,
  renovateUpdateTypeSchema,
} from './model.ts'

const text = z.string().nullish()

const lookupUpdateSchema = z.looseObject({
  newValue: text,
  newVersion: text,
  updateType: z.string().optional(),
  isVulnerabilityAlert: z.boolean().optional(),
  pendingChecks: z.boolean().optional(),
  branchName: z.string().optional(),
  releaseTimestamp: z.string().optional(),
})

const dependencySchema = z.looseObject({
  depName: text,
  packageName: text,
  depType: text,
  currentValue: text,
  currentVersion: text,
  skipReason: text,
  deprecationMessage: text,
  isAbandoned: z.boolean().optional(),
  sourceUrl: text,
  homepage: text,
  updates: z.array(lookupUpdateSchema).optional(),
})

const packageFileSchema = z.looseObject({
  packageFile: z.string(),
  deps: z.array(dependencySchema).default([]),
})

const branchSchema = z.looseObject({
  branchName: z.string(),
  prNo: z.number().nullish(),
  prTitle: text,
  result: text,
  upgrades: z
    .array(z.looseObject({ updateType: z.string().optional(), depName: text }))
    .default([]),
})

const problemSchema = z.looseObject({ level: z.number(), msg: z.string().optional() })

const repoReportSchema = z.looseObject({
  problems: z.array(problemSchema).default([]),
  branches: z.array(branchSchema).default([]),
  packageFiles: z.record(z.string(), z.array(packageFileSchema)).default({}),
  libYearsWithStatus: z
    .looseObject({
      libYears: z.looseObject({ total: z.number() }).optional(),
      dependencyStatus: z.looseObject({ outdated: z.number(), total: z.number() }).optional(),
    })
    .optional(),
})

const reportSchema = z.looseObject({
  problems: z.array(problemSchema).default([]),
  repositories: z.record(z.string(), repoReportSchema).default({}),
})

/** A branch Renovate keeps for the repository, as its report lists it. */
export interface RenovateBranch {
  branch: string
  mergeRequest?: number
  title?: string
  result?: string
  types: RenovateUpdateType[]
  updates: number
}

/** What the analyzer reads from Renovate's `reportType: file` report for one repository. */
export interface ParsedReport {
  dependencies: number
  outdated: number
  libYears?: number
  managers: { manager: string; files: number; dependencies: number }[]
  updates: RenovateUpdate[]
  deprecated: RenovateDeprecation[]
  branches: RenovateBranch[]
  problems: RenovateProblem[]
}

const updateType = (value: string | undefined) => {
  const parsed = renovateUpdateTypeSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

// Renovate marks the update itself only sometimes; its vulnerability branches always end like this.
const isVulnerability = (update: z.output<typeof lookupUpdateSchema>) =>
  Boolean(update.isVulnerabilityAlert) || Boolean(update.branchName?.endsWith('-vulnerability'))

const problemLevel = (level: number): RenovateProblem['level'] | undefined =>
  level >= 60 ? 'fatal' : level >= 50 ? 'error' : level >= 40 ? 'warning' : undefined

/**
 * Reads one repository out of a Renovate report (Renovate 44, `reportType: file`). Fields Renovate
 * leaves out are skipped rather than rejected, so a newer Renovate degrades to fewer details.
 * Problems logged outside any repository count for every repository. Throws when the text is not
 * a report at all.
 */
export function parseRenovateReport(json: string, repo: string): ParsedReport {
  const report = reportSchema.parse(JSON.parse(json))
  const entry =
    report.repositories[repo] ??
    Object.entries(report.repositories).find(
      ([name]) => name.toLowerCase() === repo.toLowerCase(),
    )?.[1]
  const empty = repoReportSchema.parse({})
  const { packageFiles, branches, libYearsWithStatus } = entry ?? empty

  const branchByName = new Map(branches.map((branch) => [branch.branchName, branch]))
  const managers: ParsedReport['managers'] = []
  const updates: RenovateUpdate[] = []
  const deprecated: RenovateDeprecation[] = []
  let dependencies = 0
  let outdated = 0

  for (const [manager, files] of Object.entries(packageFiles)) {
    let declared = 0
    for (const file of files)
      for (const dep of file.deps) {
        if (dep.skipReason) continue
        declared += 1
        const name = dep.depName ?? dep.packageName ?? 'unknown'
        const current = dep.currentVersion ?? dep.currentValue ?? undefined
        const url = dep.sourceUrl ?? dep.homepage ?? undefined
        if (dep.deprecationMessage || dep.isAbandoned)
          deprecated.push({
            dependency: name,
            manager,
            file: file.packageFile,
            ...(dep.deprecationMessage && { message: dep.deprecationMessage }),
            abandoned: Boolean(dep.isAbandoned),
          })
        let found = false
        for (const update of dep.updates ?? []) {
          const type = updateType(update.updateType)
          if (!type) continue
          found = true
          const next = update.newVersion ?? update.newValue ?? undefined
          const prNo = update.branchName ? branchByName.get(update.branchName)?.prNo : undefined
          updates.push({
            dependency: name,
            manager,
            file: file.packageFile,
            ...(dep.depType && { depType: dep.depType }),
            ...(current && { current }),
            ...(next && { next }),
            type,
            vulnerability: isVulnerability(update),
            pending: Boolean(update.pendingChecks),
            ...(update.releaseTimestamp && { releasedAt: update.releaseTimestamp }),
            ...(url && { url }),
            ...(typeof prNo === 'number' && { mergeRequest: prNo }),
          })
        }
        if (found) outdated += 1
      }
    managers.push({ manager, files: files.length, dependencies: declared })
    dependencies += declared
  }

  const problems = [...report.problems, ...(entry?.problems ?? [])].flatMap((problem) => {
    const level = problemLevel(problem.level)
    return level && problem.msg ? [{ level, message: problem.msg }] : []
  })

  return {
    dependencies,
    outdated,
    ...(libYearsWithStatus?.libYears && { libYears: libYearsWithStatus.libYears.total }),
    managers: managers.toSorted((a, b) => b.dependencies - a.dependencies),
    updates,
    deprecated,
    branches: branches.map((branch) => ({
      branch: branch.branchName,
      ...(typeof branch.prNo === 'number' && { mergeRequest: branch.prNo }),
      ...(branch.prTitle && { title: branch.prTitle }),
      ...(branch.result && { result: branch.result }),
      types: [...new Set(branch.upgrades.flatMap((u) => updateType(u.updateType) ?? []))],
      updates: branch.upgrades.length,
    })),
    problems: [...new Map(problems.map((p) => [`${p.level}:${p.message}`, p])).values()],
  }
}
