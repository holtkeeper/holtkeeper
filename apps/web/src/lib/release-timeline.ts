import type {
  Acceptance,
  DeployAttempt,
  DeployStatus,
  EnvironmentSummary,
  GateResult,
  GateSeverity,
  PersonView,
  ReleaseBoardRow,
  ReleasePlan,
  ReleaseRepoView,
  ReleaseVersionView,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import type { DotTone } from '../ui/Legend.tsx'
import type { Tick } from '../ui/TickStrip.tsx'
import { formatDuration } from './format.ts'
import { exampleTag } from './release-flow.ts'
import { actorName, failingGates } from './releases.ts'

/** The header line of a repository's timeline: its flow, target branch and tag format. */
export function flowSummary(view: Pick<ReleaseRepoView, 'settings' | 'row'>): string {
  const { flow, version } = view.settings
  if (flow.mode === 'external') return 'Released by another tool'
  const target = view.row.target ?? flow.target ?? 'the default branch'
  const tags = exampleTag(version)
  return flow.mode === 'trunk'
    ? `Trunk flow · versions are tagged on ${target} as ${tags}`
    : `${flow.source} → ${target} through a release merge request · tagged as ${tags}`
}

const severityWords: Record<GateSeverity, string> = {
  block: 'blocks',
  warn: 'warns',
  info: 'info',
}

/** One line of the gates checklist. */
export interface GateRow {
  key: string
  /** The gate's id, e.g. `changelog`. */
  id: string
  ok: boolean
  /** `success` when it passes; a failing gate takes its severity's tone. */
  tone: StatusTone
  text: string
  severity: GateSeverity
  /** What the severity means in a word: `blocks`, `warns` or `info`. */
  severityText: string
  /** More about the gate in words, e.g. what the changelog holds. */
  detail?: string
}

const sentence = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text)

/** The gates of a plan as checklist lines in their order, each with its severity in words. */
export function gateRows(gates: readonly GateResult[]): GateRow[] {
  return gates.map((gate, index) => ({
    key: `${gate.id}-${index}`,
    id: gate.id,
    ok: gate.ok,
    tone: gate.ok
      ? 'success'
      : gate.severity === 'block'
        ? 'danger'
        : gate.severity === 'warn'
          ? 'warning'
          : 'default',
    text: sentence(gate.message),
    severity: gate.severity,
    severityText: severityWords[gate.severity],
  }))
}

const notesSources: Record<ReleasePlan['summary']['source'], string> = {
  agent: 'written by AI',
  person: 'edited by a person',
  changelog: 'digest of the changelog',
  none: 'no notes',
}

/** Where the notes of a plan or a version come from, e.g. `written by AI`. */
const notesSourceText = (source: ReleasePlan['summary']['source']): string => notesSources[source]

function changelogReady(
  plan: Pick<ReleasePlan, 'entries' | 'changelog' | 'summary'>,
  changelogFile: boolean,
): { ready: boolean; title: string; detail: string } {
  const included = plan.entries.filter((entry) => entry.included).length
  const leftOut = plan.entries.length - included
  const ready = included > 0 && plan.changelog.trim() !== ''
  return {
    ready,
    title: ready ? 'Changelog ready' : 'Changelog empty',
    detail: [
      `${included} ${included === 1 ? 'entry' : 'entries'}`,
      ...(leftOut ? [`${leftOut} left out`] : []),
      `notes ${notesSourceText(plan.summary.source)}`,
      ...(changelogFile ? ['prepended to CHANGELOG.md'] : []),
    ].join(' · '),
  }
}

/**
 * The checklist of a plan: its gates in order with exactly one changelog line. The plan's own
 * changelog gate carries what the changelog holds; without one, a line says whether it is empty.
 */
export function checklistRows(
  plan: Pick<ReleasePlan, 'gates' | 'entries' | 'changelog' | 'summary'>,
  changelogFile: boolean,
): GateRow[] {
  const changelog = changelogReady(plan, changelogFile)
  const rows = gateRows(plan.gates).map((row) =>
    row.id === 'changelog' ? { ...row, detail: changelog.detail } : row,
  )
  if (rows.some((row) => row.id === 'changelog')) return rows
  return [
    ...rows,
    {
      key: 'changelog',
      id: 'changelog',
      ok: changelog.ready,
      tone: changelog.ready ? 'success' : 'warning',
      text: changelog.title,
      severity: 'warn',
      severityText: severityWords.warn,
      detail: changelog.detail,
    },
  ]
}

/** Whether the pending version waits for an acceptance the flow asks for. */
export const awaitsAcceptance = (
  row: Pick<ReleaseBoardRow, 'acceptanceRequired' | 'acceptance'>,
): boolean => row.acceptanceRequired && row.acceptance === undefined

/**
 * Why the step's button is off, or `undefined` when it may run: a gate nobody may override
 * fails, or a version waits for its acceptance.
 */
export function stepBlockedBy(
  step: ReleasePlan['step'],
  gates: readonly GateResult[],
  row: Pick<ReleaseBoardRow, 'acceptanceRequired' | 'acceptance'>,
): string | undefined {
  const [hard] = failingGates(gates).hard
  if (hard) return sentence(hard.message)
  if (step === 'version' && awaitsAcceptance(row)) return 'Opens after acceptance'
  return undefined
}

/** What started a deploy job does: deploy, retry or deploy again, by the environment's status. */
export type DeployKind = 'deploy' | 'retry' | 'redeploy'

/** The deploy action an environment offers in its status; `undefined` while a job runs or none can. */
export const deployKind = (status: DeployStatus): DeployKind | undefined =>
  status === 'ready' || status === 'waiting'
    ? 'deploy'
    : status === 'failed' || status === 'canceled'
      ? 'retry'
      : status === 'success'
        ? 'redeploy'
        : undefined

/** Button text of a deploy action. */
export const deployKindLabel: Record<DeployKind, string> = {
  deploy: 'Deploy',
  retry: 'Retry',
  redeploy: 'Deploy again',
}

/** When an environment's job may start and whether it asks first, e.g. `after staging · asks before starting`. */
export const environmentOrder = (environment: { after?: string; confirm: boolean }): string =>
  [
    environment.after ? `after ${environment.after}` : 'right after the tag',
    ...(environment.confirm ? ['asks before starting'] : []),
  ].join(' · ')

const attemptLabels: Record<DeployAttempt['status'], string> = {
  created: 'Created',
  pending: 'Pending',
  running: 'Running',
  success: 'Deployed',
  failed: 'Failed',
  canceled: 'Canceled',
  skipped: 'Skipped',
  manual: 'Manual',
}

const attemptTones: Record<DeployAttempt['status'], StatusTone> = {
  created: 'default',
  pending: 'info',
  running: 'info',
  success: 'success',
  failed: 'danger',
  canceled: 'warning',
  skipped: 'default',
  manual: 'default',
}

/** One run of a deploy job in words. */
export interface AttemptLine {
  status: string
  tone: StatusTone
  /** `started by Ana S.` when it was started through Holtkeeper. */
  by?: string
  reason?: string
  duration?: string
}

/** A deploy attempt's status, who started it through Holtkeeper and why, and how long it took. */
export function attemptLine(
  attempt: DeployAttempt,
  people: Readonly<Record<string, PersonView>>,
): AttemptLine {
  return {
    status: attemptLabels[attempt.status],
    tone: attemptTones[attempt.status],
    ...(attempt.actor
      ? { by: `started by ${actorName(people, attempt.actor, attempt.actorName)}` }
      : {}),
    ...(attempt.reason ? { reason: attempt.reason } : {}),
    ...(attempt.durationSeconds !== undefined
      ? { duration: formatDuration(attempt.durationSeconds * 1000) }
      : {}),
  }
}

/** Environment names of the versions table: the configured ones in order, then any others deployed to. */
export function versionEnvironments(
  configured: readonly string[],
  versions: readonly Pick<ReleaseVersionView, 'deploys'>[],
): string[] {
  return [
    ...new Set([
      ...configured,
      ...versions.flatMap((version) => version.deploys.map((deploy) => deploy.environment)),
    ]),
  ]
}

/** Where a version stands on one environment by its newest recorded deploy. */
export interface DeployCell {
  label: 'Deployed' | 'Deploying' | 'Failed' | 'Not deployed'
  tone: DotTone
}

/** The newest recorded deploy of `version` to `environment` in words. */
export function versionDeployCell(
  version: Pick<ReleaseVersionView, 'deploys'>,
  environment: string,
): DeployCell {
  const deploy = version.deploys.find((candidate) => candidate.environment === environment)
  if (!deploy) return { label: 'Not deployed', tone: 'none' }
  if (deploy.status === 'succeeded') return { label: 'Deployed', tone: 'success' }
  if (deploy.status === 'failed') return { label: 'Failed', tone: 'danger' }
  return { label: 'Deploying', tone: 'info' }
}

/** One tick per environment of `environments` for a version, labelled with where it stands. */
export function versionTicks(
  version: Pick<ReleaseVersionView, 'deploys'>,
  environments: readonly string[],
): Tick[] {
  return environments.map((name) => {
    const cell = versionDeployCell(version, name)
    return {
      tone: cell.tone === 'none' ? 'skipped' : cell.tone,
      label: `${name}: ${cell.label.toLowerCase()}`,
    }
  })
}

/** "4 commits · 2 tasks", "300+ commits · 0 tasks". */
export const changesText = (
  version: Pick<ReleaseVersionView, 'commitCount' | 'capped' | 'tickets'>,
): string => {
  const commits = `${version.commitCount}${version.capped ? '+' : ''} ${version.commitCount === 1 && !version.capped ? 'commit' : 'commits'}`
  const tasks = version.tickets.length
  return `${commits} · ${tasks} ${tasks === 1 ? 'task' : 'tasks'}`
}

/** What narrows the versions table. */
export interface VersionFilter {
  /** Matches a tag, version, commit prefix or task key, ignoring case. */
  query: string
  /** Bumps to keep; empty keeps all. */
  bumps: readonly string[]
  /** Keeps versions deployed to any of these environments; empty keeps all. */
  environments: readonly string[]
}

/** The loaded versions `filter` keeps, in their order. */
export function filterVersions<T extends ReleaseVersionView>(
  versions: readonly T[],
  filter: VersionFilter,
): T[] {
  const query = filter.query.trim().toLowerCase()
  return versions.filter((version) => {
    if (filter.bumps.length && !filter.bumps.includes(version.bump)) return false
    if (
      filter.environments.length &&
      !filter.environments.some((name) => versionDeployCell(version, name).label === 'Deployed')
    )
      return false
    if (!query) return true
    return (
      version.tag.toLowerCase().includes(query) ||
      version.version.toLowerCase().includes(query) ||
      version.sha.toLowerCase().startsWith(query) ||
      version.tickets.some((ticket) => ticket.toLowerCase().includes(query))
    )
  })
}

/** Environments that run `tag` now, in their configured order. */
export const liveOn = (environments: readonly EnvironmentSummary[], tag: string): string[] =>
  environments.filter((environment) => environment.tag === tag).map((env) => env.name)

const viaWords: Record<Acceptance['via'], string> = {
  manual: 'by a person',
  label: 'by the release-accepted label',
  merge: 'by merging the release MR',
}

/** How a version was accepted, e.g. `by the release-accepted label`. */
export const acceptedVia = (via: Acceptance['via']): string => viaWords[via]

/** Where the notes of a created version came from and whether a person changed the plan. */
export const versionNotesText = (notes: {
  source: ReleasePlan['summary']['source']
  edited: boolean
}): string => {
  const source = notesSourceText(notes.source)
  return `${source[0]!.toUpperCase()}${source.slice(1)} · ${notes.edited ? 'plan edited' : 'not edited'}`
}
