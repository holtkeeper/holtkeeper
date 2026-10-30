import { type Tone, formatBytes } from '@holtkeeper/report'
import { findingKey } from '@holtkeeper/vuln'

import type {
  BundleView,
  ChangelogView,
  ChangelogViewCommit,
  InputName,
  RiskInputs,
  RiskSource,
} from './inputs.ts'
import type {
  Evidence,
  FactorId,
  ReleaseRiskData,
  RiskFactor,
  RiskLevel,
  SourceRef,
  TestArea,
} from './schema.ts'

/** Most points each factor may contribute. Defaults sum above 100; the score is capped at 100. */
export type RiskWeights = Record<FactorId, number>

/** Default factor weights. */
export const defaultWeights: RiskWeights = {
  size: 15,
  breaking: 20,
  bundle: 15,
  vulnerabilities: 25,
  untested: 15,
  dependencies: 10,
  quality: 10,
  contributors: 10,
}

/** Everything an assessment says except the summary, which may need an agent. */
export type RiskAssessment = Omit<ReleaseRiskData, 'summary'>

/** A package that is new in the bundle at or above this gzip size counts as heavy. */
export const HEAVY_PACKAGE_GZIP = 10 * 1024

const confidenceShare: Record<InputName, number> = {
  changelog: 0.3,
  bundle: 0.1,
  previousBundle: 0.05,
  quality: 0.1,
  previousQuality: 0.05,
  depgraph: 0.1,
  previousDepgraph: 0.05,
  audit: 0.2,
  previousAudit: 0.05,
}

const missingReason: Record<InputName, string> = {
  changelog: 'no changelog for this release',
  bundle: 'no bundle analysis for this release',
  previousBundle: 'no bundle analysis of an earlier release',
  quality: 'no quality analysis',
  previousQuality: 'no earlier quality analysis to compare with',
  depgraph: 'no dependency graph',
  previousDepgraph: 'no earlier dependency graph to compare with',
  audit: 'no audit run',
  previousAudit: 'no earlier audit run to compare with',
}

const labels: Record<FactorId, string> = {
  size: 'Size of change',
  breaking: 'Breaking changes and reverts',
  bundle: 'Bundle growth',
  vulnerabilities: 'New vulnerabilities',
  untested: 'Changed code without tests',
  dependencies: 'Dependency cycles and duplicates',
  quality: 'New quality errors',
  contributors: 'Contributors and hotspots',
}

/** Link to a source's page: analyses have their own page, audit runs are listed under audits. */
export const sourceHref = (source: Pick<RiskSource<unknown>, 'id' | 'kind'>) =>
  source.kind === 'audit' ? '/audits' : `/analyses/${source.id}`

const sourceEvidence = (source: RiskSource<unknown>): Evidence => ({
  label: `${source.kind}${source.ref ? ` ${source.ref}` : ''}`,
  href: sourceHref(source),
})

const saturate = (value: number, half: number) => (value <= 0 ? 0 : value / (value + half))
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const plural = (count: number, word: string, many = `${word}s`) =>
  `${count} ${count === 1 ? word : many}`

function toneOf(points: number, max: number): Tone {
  if (max === 0 || points === 0) return 'good'
  const ratio = points / max
  if (ratio >= 0.6) return 'bad'
  if (ratio >= 0.25) return 'warning'
  return 'info'
}

function factor(
  id: FactorId,
  weights: RiskWeights,
  fraction: number,
  detail: string,
  evidence: Evidence[],
  tone?: Tone,
): RiskFactor {
  const max = weights[id]
  const points = Math.round(max * clamp01(fraction))
  return {
    id,
    label: labels[id],
    points,
    max,
    detail,
    tone: tone ?? toneOf(points, max),
    known: true,
    evidence,
  }
}

const unknown = (
  id: FactorId,
  weights: RiskWeights,
  detail: string,
  evidence: Evidence[] = [],
): RiskFactor => ({
  id,
  label: labels[id],
  points: 0,
  max: weights[id],
  detail,
  tone: 'neutral',
  known: false,
  evidence,
})

const isMerge = (commit: ChangelogViewCommit) => commit.parsed.merge || commit.parents.length > 1

/** Commits that carry changes: no merges. */
export const regularCommits = (changelog: ChangelogView) =>
  changelog.commits.filter((commit) => !isMerge(commit))

const titleOf = (commit: ChangelogViewCommit) => commit.parsed.description || commit.subject

const commitEvidence = (changelog: ChangelogView, commit: ChangelogViewCommit): Evidence => ({
  label: titleOf(commit),
  ...(changelog.links ? { href: changelog.links.commit.replaceAll('{sha}', commit.sha) } : {}),
})

const isRevert = (commit: ChangelogViewCommit) =>
  commit.parsed.revert !== undefined || commit.parsed.type === 'revert'

function sizeFactor(inputs: RiskInputs, weights: RiskWeights): RiskFactor {
  const changelog = inputs.changelog
  if (!changelog) return unknown('size', weights, 'No changelog for this release.')
  const commits = regularCommits(changelog.data)
  const stat = changelog.data.diff ?? {
    files: Math.max(0, ...commits.map((commit) => commit.stats?.files ?? 0)),
    insertions: commits.reduce((sum, commit) => sum + (commit.stats?.insertions ?? 0), 0),
    deletions: commits.reduce((sum, commit) => sum + (commit.stats?.deletions ?? 0), 0),
  }
  const lines = stat.insertions + stat.deletions
  const fraction =
    0.3 * saturate(commits.length, 40) +
    0.4 * saturate(lines, 2000) +
    0.3 * saturate(stat.files, 80)
  const files = changelog.data.diff ? ` in ${plural(stat.files, 'file')}` : ''
  return factor(
    'size',
    weights,
    fraction,
    `${plural(commits.length, 'commit')}, +${stat.insertions}/-${stat.deletions} lines${files}.`,
    [sourceEvidence(changelog)],
  )
}

function breakingFactor(inputs: RiskInputs, weights: RiskWeights): RiskFactor {
  const changelog = inputs.changelog
  if (!changelog) return unknown('breaking', weights, 'No changelog for this release.')
  const commits = regularCommits(changelog.data)
  const breaking = commits.filter((commit) => commit.parsed.breaking)
  const reverts = commits.filter(isRevert)
  const parts = [
    breaking.length > 0 ? plural(breaking.length, 'breaking change') : '',
    reverts.length > 0 ? plural(reverts.length, 'revert') : '',
  ].filter(Boolean)
  return factor(
    'breaking',
    weights,
    0.5 * breaking.length + 0.2 * reverts.length,
    parts.length > 0 ? `${parts.join(', ')}.` : 'No breaking changes or reverts.',
    [
      ...[...breaking, ...reverts]
        .slice(0, 5)
        .map((commit) => commitEvidence(changelog.data, commit)),
      sourceEvidence(changelog),
    ],
    breaking.length > 0 ? 'bad' : undefined,
  )
}

/** Gzip bytes of the bundle's JS and CSS. */
export const bundleGzip = (bundle: BundleView) =>
  bundle.assets
    .filter((asset) => asset.kind === 'js' || asset.kind === 'css')
    .reduce((sum, asset) => sum + asset.gzip, 0)

function bundleFactor(inputs: RiskInputs, weights: RiskWeights): RiskFactor {
  const { bundle, previousBundle } = inputs
  if (!bundle) return unknown('bundle', weights, 'No bundle analysis for this release.')
  const current = bundleGzip(bundle.data)
  if (!previousBundle)
    return unknown(
      'bundle',
      weights,
      `No earlier bundle to compare with; JS and CSS are ${formatBytes(current)} gzip.`,
      [sourceEvidence(bundle)],
    )
  const before = bundleGzip(previousBundle.data)
  const delta = current - before
  const share = before > 0 ? delta / before : 0
  const known = new Set(previousBundle.data.packages.map((pkg) => pkg.name))
  const heavy = bundle.data.packages
    .filter((pkg) => !known.has(pkg.name) && pkg.gzip >= HEAVY_PACKAGE_GZIP)
    .toSorted((a, b) => b.gzip - a.gzip)
  const sign = delta > 0 ? '+' : ''
  const percent = before > 0 ? ` (${sign}${(share * 100).toFixed(1)}%)` : ''
  const heavyText =
    heavy.length > 0
      ? ` New heavy packages: ${heavy
          .slice(0, 5)
          .map((pkg) => `${pkg.name} (${formatBytes(pkg.gzip)})`)
          .join(', ')}.`
      : ''
  return factor(
    'bundle',
    weights,
    Math.max(0, share) / 0.1 + 0.25 * heavy.length,
    `${sign}${formatBytes(delta)} gzip${percent} against ${previousBundle.ref ?? 'the previous build'}.${heavyText}`,
    [sourceEvidence(bundle), sourceEvidence(previousBundle)],
  )
}

function vulnerabilityFactor(inputs: RiskInputs, weights: RiskWeights): RiskFactor {
  const { audit, previousAudit } = inputs
  if (!audit) return unknown('vulnerabilities', weights, 'No audit run.')
  const seen = new Set(previousAudit?.data.findings.map(findingKey) ?? [])
  const fresh = audit.data.findings.filter((finding) => !seen.has(findingKey(finding)))
  const critical = fresh.filter((finding) => finding.severity === 'critical')
  const high = fresh.filter((finding) => finding.severity === 'high')
  const total = audit.data.findings.length
  const newWord = previousAudit ? 'new ' : ''
  const parts = [
    critical.length > 0 ? `${critical.length} ${newWord}critical` : '',
    high.length > 0 ? `${high.length} ${newWord}high` : '',
  ].filter(Boolean)
  const detail =
    parts.length > 0
      ? `${parts.join(', ')} ${critical.length + high.length === 1 ? 'vulnerability' : 'vulnerabilities'}; ${total} open in total.`
      : `No ${newWord}high or critical vulnerabilities; ${total} open in total.`
  return factor(
    'vulnerabilities',
    weights,
    critical.length + 0.4 * high.length,
    previousAudit ? detail : `${detail} No earlier audit to compare with, so all count as new.`,
    [
      ...[...critical, ...high].slice(0, 5).map((finding) => ({
        label: `${finding.id} in ${finding.package.name}`,
        href: finding.url,
      })),
      sourceEvidence(audit),
    ],
    critical.length > 0 ? 'bad' : undefined,
  )
}

interface UntestedFile {
  file: string
  symbols: string[]
}

function untestedFiles(inputs: RiskInputs): UntestedFile[] | undefined {
  const files = inputs.changelog?.data.files
  if (!files || !inputs.quality) return undefined
  const changed = new Set(files)
  const byFile = new Map<string, string[]>()
  for (const gap of inputs.quality.data.tests) {
    if (!changed.has(gap.file)) continue
    byFile.set(gap.file, [...(byFile.get(gap.file) ?? []), gap.symbol])
  }
  return [...byFile].map(([file, symbols]) => ({ file, symbols }))
}

function untestedFactor(inputs: RiskInputs, weights: RiskWeights): RiskFactor {
  const { quality } = inputs
  if (!quality) return unknown('untested', weights, 'No quality analysis with test gaps.')
  const evidence = [sourceEvidence(quality)]
  const gaps = untestedFiles(inputs)
  if (gaps) {
    const names = gaps.slice(0, 5).map((gap) => gap.file)
    return factor(
      'untested',
      weights,
      gaps.length / 5,
      gaps.length > 0
        ? `${plural(gaps.length, 'changed file')} with untested code: ${names.join(', ')}${gaps.length > names.length ? ', ...' : ''}.`
        : 'Every changed file is covered by tests.',
      evidence,
    )
  }
  const lines = quality.data.coverage?.lines
  if (lines && lines.total > 0) {
    const share = lines.covered / lines.total
    return factor(
      'untested',
      weights,
      0.5 * clamp01((0.8 - share) / 0.8),
      `Changed files are unknown; overall line coverage is ${Math.round(share * 100)}%.`,
      evidence,
    )
  }
  return unknown('untested', weights, 'Neither changed files nor coverage are known.', evidence)
}

const cycleKeys = (data: NonNullable<RiskInputs['depgraph']>['data']) =>
  new Set(
    data.layers.flatMap((layer) =>
      layer.cycles.map((cycle) => `${layer.id}:${cycle.members.toSorted().join(',')}`),
    ),
  )

const duplicateKeys = (data: NonNullable<RiskInputs['depgraph']>['data']) =>
  new Set(
    data.layers.flatMap((layer) => layer.duplicates.map((dup) => `${dup.ecosystem}:${dup.name}`)),
  )

function dependencyFactor(inputs: RiskInputs, weights: RiskWeights): RiskFactor {
  const { depgraph, previousDepgraph } = inputs
  if (!depgraph) return unknown('dependencies', weights, 'No dependency graph.')
  const cycles = cycleKeys(depgraph.data)
  const duplicates = duplicateKeys(depgraph.data)
  if (!previousDepgraph)
    return unknown(
      'dependencies',
      weights,
      `No earlier graph to compare with; ${plural(cycles.size, 'cycle')} and ${plural(duplicates.size, 'duplicated library', 'duplicated libraries')} now.`,
      [sourceEvidence(depgraph)],
    )
  const oldCycles = cycleKeys(previousDepgraph.data)
  const oldDuplicates = duplicateKeys(previousDepgraph.data)
  const newCycles = [...cycles].filter((key) => !oldCycles.has(key))
  const newDuplicates = [...duplicates].filter((key) => !oldDuplicates.has(key))
  const parts = [
    newCycles.length > 0 ? plural(newCycles.length, 'new cycle') : '',
    newDuplicates.length > 0
      ? `${plural(newDuplicates.length, 'new duplicated library', 'new duplicated libraries')} (${newDuplicates
          .slice(0, 5)
          .map((key) => key.slice(key.indexOf(':') + 1))
          .join(', ')})`
      : '',
  ].filter(Boolean)
  return factor(
    'dependencies',
    weights,
    0.4 * newCycles.length + 0.1 * newDuplicates.length,
    parts.length > 0 ? `${parts.join(', ')}.` : 'No new cycles or duplicated libraries.',
    [sourceEvidence(depgraph), sourceEvidence(previousDepgraph)],
  )
}

function qualityFactor(inputs: RiskInputs, weights: RiskWeights): RiskFactor {
  const { quality, previousQuality } = inputs
  if (!quality) return unknown('quality', weights, 'No quality analysis.')
  const errors = quality.data.issues.filter((issue) => issue.severity === 'error')
  if (!previousQuality)
    return unknown(
      'quality',
      weights,
      `No earlier quality analysis to compare with; ${plural(errors.length, 'error')} now.`,
      [sourceEvidence(quality)],
    )
  const seen = new Set(previousQuality.data.issues.map((issue) => issue.id))
  const fresh = quality.data.issues.filter((issue) => !seen.has(issue.id))
  const newErrors = fresh.filter((issue) => issue.severity === 'error')
  const newWarnings = fresh.filter((issue) => issue.severity === 'warning')
  return factor(
    'quality',
    weights,
    newErrors.length / 10 + newWarnings.length / 100,
    newErrors.length + newWarnings.length > 0
      ? `${plural(newErrors.length, 'new error')}, ${plural(newWarnings.length, 'new warning')}.`
      : 'No new errors or warnings.',
    [
      ...newErrors.slice(0, 5).map((issue) => ({
        label: `${issue.rule || 'error'}${issue.file ? ` in ${issue.file}` : ''}: ${issue.message}`,
        ...(issue.url ? { href: issue.url } : {}),
      })),
      sourceEvidence(quality),
      sourceEvidence(previousQuality),
    ],
  )
}

/** Scopes with at least this many commits in one release count as hotspots. */
const HOTSPOT_COMMITS = 5

function contributorFactor(inputs: RiskInputs, weights: RiskWeights): RiskFactor {
  const changelog = inputs.changelog
  if (!changelog) return unknown('contributors', weights, 'No changelog for this release.')
  const commits = regularCommits(changelog.data)
  const authors = new Set(commits.map((commit) => commit.author.name))
  const scopes = new Map<string, number>()
  for (const commit of commits) {
    const scope = commit.parsed.scope?.toLowerCase()
    if (scope) scopes.set(scope, (scopes.get(scope) ?? 0) + 1)
  }
  const hotspots = [...scopes]
    .filter(([, count]) => count >= HOTSPOT_COMMITS)
    .toSorted((a, b) => b[1] - a[1])
  const hot =
    hotspots.length > 0
      ? `; busiest areas: ${hotspots
          .slice(0, 3)
          .map(([scope, count]) => `${scope} (${count} commits)`)
          .join(', ')}`
      : ''
  return factor(
    'contributors',
    weights,
    0.7 * saturate(authors.size - 1, 6) + 0.3 * Math.min(1, hotspots.length / 3),
    `${plural(authors.size, 'contributor')}${hot}.`,
    [sourceEvidence(changelog)],
  )
}

/** `0..100` → level. */
export function riskLevel(score: number): RiskLevel {
  if (score >= 75) return 'critical'
  if (score >= 50) return 'high'
  if (score >= 25) return 'medium'
  return 'low'
}

const toneRank: Record<Tone, number> = { bad: 4, warning: 3, info: 2, neutral: 1, good: 0 }

const userFacing = new Set(['feat', 'fix', 'perf', 'refactor', 'revert'])

/**
 * Areas QA should test: changed scopes (or `General` for unscoped changes) with the changes in
 * them, then changed files that have untested code. Riskiest first, at most 15.
 */
export function testAreas(inputs: RiskInputs): TestArea[] {
  const areas = new Map<string, TestArea>()
  const commits = inputs.changelog ? regularCommits(inputs.changelog.data) : []
  for (const commit of commits) {
    const { type, scope, breaking, wip } = commit.parsed
    if (wip) continue
    if (!breaking && type !== undefined && !userFacing.has(type)) continue
    const name = scope ?? 'General'
    const key = name.toLowerCase()
    const tone: Tone = breaking
      ? 'bad'
      : isRevert(commit) || type === 'fix'
        ? 'warning'
        : type === 'feat'
          ? 'info'
          : 'neutral'
    const area = areas.get(key) ?? { area: name, reasons: [], tone, commits: 0 }
    area.commits++
    if (toneRank[tone] > toneRank[area.tone]) area.tone = tone
    const title = titleOf(commit)
    if (!area.reasons.includes(title) && area.reasons.length < 5) area.reasons.push(title)
    areas.set(key, area)
  }
  const fromFiles = (untestedFiles(inputs) ?? []).map((gap): TestArea => ({
    area: gap.file,
    reasons: [`changed without tests: ${gap.symbols.slice(0, 5).join(', ')}`],
    tone: 'warning',
    commits: 0,
  }))
  return [
    ...[...areas.values()].toSorted(
      (a, b) => toneRank[b.tone] - toneRank[a.tone] || b.commits - a.commits,
    ),
    ...fromFiles,
  ].slice(0, 15)
}

const inputNames: InputName[] = [
  'changelog',
  'bundle',
  'previousBundle',
  'quality',
  'previousQuality',
  'depgraph',
  'previousDepgraph',
  'audit',
  'previousAudit',
]

/** The records an assessment used, with links to their pages. */
export function sourcesOf(inputs: RiskInputs): SourceRef[] {
  return inputNames.flatMap((name) => {
    const source = inputs[name]
    return source
      ? [
          {
            id: source.id,
            kind: source.kind,
            ...(source.ref ? { ref: source.ref } : {}),
            createdAt: source.createdAt,
            href: sourceHref(source),
          },
        ]
      : []
  })
}

/**
 * Scores a release from explainable factors. Pure and deterministic. Missing inputs make their
 * factors `known: false` with 0 points and lower `confidence`; nothing throws for absent data.
 */
export function assessRisk(inputs: RiskInputs, weights: Partial<RiskWeights> = {}): RiskAssessment {
  const merged = { ...defaultWeights, ...weights }
  const factors = [
    vulnerabilityFactor(inputs, merged),
    breakingFactor(inputs, merged),
    sizeFactor(inputs, merged),
    bundleFactor(inputs, merged),
    untestedFactor(inputs, merged),
    dependencyFactor(inputs, merged),
    qualityFactor(inputs, merged),
    contributorFactor(inputs, merged),
  ]
  const score = Math.min(
    100,
    factors.reduce((sum, item) => sum + item.points, 0),
  )
  const unreadable = new Map((inputs.unreadable ?? []).map((item) => [item.input, item.reason]))
  const missing = inputNames
    .filter((name) => !inputs[name])
    .map((name) => ({ input: name, reason: unreadable.get(name) ?? missingReason[name] }))
  const confidence = inputNames
    .filter((name) => inputs[name])
    .reduce((sum, name) => sum + confidenceShare[name], 0)
  const ref = inputs.ref ?? inputs.changelog?.data.to.name ?? inputs.changelog?.ref
  return {
    ...(ref ? { ref } : {}),
    score,
    level: riskLevel(score),
    confidence: Math.round(confidence * 100) / 100,
    factors,
    missing,
    testAreas: testAreas(inputs),
    sources: sourcesOf(inputs),
  }
}
