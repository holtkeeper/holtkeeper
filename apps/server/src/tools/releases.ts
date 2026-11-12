import {
  type RegistryTool,
  type RegistryToolset,
  ToolError,
  defineTool,
} from '@holtkeeper/agent-tools'
import type { ReleaseBoardRow, ReleaseRepoView, ReleaseStepResult } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import type {
  EnvironmentSummary,
  GateResult,
  ReleaseSettings,
  ReleaseStage,
  ReleaseTask,
} from '@holtkeeper/release'
import { z } from 'zod'

import type { ReleaseStepPreview } from '../release-steps.ts'
import type { ReleaseChanges } from '../releases.ts'

/** Arguments of one release step. */
export interface ReleaseStepInput {
  action: 'propose' | 'accept' | 'version' | 'deploy'
  environment?: string
  tag?: string
  /** Run although soft gates fail (or the deploy order is not met). */
  override?: boolean
  /** `propose` only: have the AI agent write the notes first. */
  writeNotes?: boolean
  /** `accept`: why it is accepted; `deploy`: why it is deployed, kept on the attempt. */
  note?: string
}

/** What the `releases` toolset reads and runs, for one caller. */
export interface ReleaseToolsAccess {
  /** The repository named `forge:path` when the caller may read its releases; else `undefined`. */
  repoOf(value: string): RepoRef | undefined
  settings(repo: RepoRef): Promise<ReleaseSettings>
  /** The repository's Guide for release notes (its `releases` and `commits` sections); empty when none. */
  guide(repo: RepoRef): Promise<string>
  status(repo: RepoRef): Promise<ReleaseRepoView>
  changes(repo: RepoRef, range: { from?: string; to?: string }): Promise<ReleaseChanges>
  /** Say only how changes were accepted, never by whom (internal agents). */
  anonymous?: boolean
  /** `release_step`; absent when the caller may not run steps through tools. */
  steps?: {
    /** A preview, and a confirm token unless the step is blocked. */
    preview(
      repo: RepoRef,
      input: ReleaseStepInput,
    ): Promise<{ preview: ReleaseStepPreview; confirm?: string }>
    run(repo: RepoRef, input: ReleaseStepInput, confirm: string): Promise<ReleaseStepResult>
  }
}

const stageSentences: Record<ReleaseStage, string> = {
  candidate: 'Changes wait for a release candidate',
  proposed: 'The release candidate is open',
  'awaiting-version': 'Merged changes wait for a version',
  released: 'Released; nothing waits',
  idle: 'Nothing released yet',
  external: 'Released by another tool',
}

/**
 * Where a repository stands in a sentence, matching the Releases screen: a forge error, then a
 * failed deploy, then the pending step (a version waits for acceptance while the flow asks for
 * one nobody gave), then a deploy that is ready or running, else the stage.
 */
export function stageText(row: ReleaseBoardRow): string {
  if (row.error) return 'Could not read the forge'
  const env = (statuses: readonly string[]) =>
    row.environments.find((candidate) => statuses.includes(candidate.status))
  const failed = env(['failed'])
  if (failed) return `Deploy to ${failed.name} failed`
  if (row.stage === 'awaiting-version' && row.acceptanceRequired && !row.acceptance)
    return 'Waiting for acceptance'
  if (row.stage === 'awaiting-version' || row.stage === 'proposed' || row.stage === 'candidate')
    return stageSentences[row.stage]
  const ready = env(['ready'])
  if (ready) return `Ready to deploy to ${ready.name}`
  const running = env(['running', 'pending'])
  if (running) return `Deploying to ${running.name}`
  return stageSentences[row.stage]
}

/** A step a person may take next, from the release state alone (no permission check). */
export interface NextReleaseStep {
  action: ReleaseStepInput['action']
  label: string
  environment?: string
  tag?: string
}

/**
 * The steps the release state allows next, in flow order: open or update the candidate, accept
 * (only when the caller's `can.accept` holds, i.e. `releases:run` and an acceptance waits),
 * create the version, deploy environments that are ready or failed. Empty for external flows.
 */
export function nextReleaseSteps(view: ReleaseRepoView): NextReleaseStep[] {
  if (view.row.mode === 'external') return []
  const steps: NextReleaseStep[] = []
  if (view.proposal) steps.push({ action: 'propose', label: 'Open the release candidate' })
  if (view.version) {
    if (view.can.accept) steps.push({ action: 'accept', label: 'Accept the changes' })
    steps.push({ action: 'version', label: `Create ${view.version.tag ?? 'the version'}` })
  }
  const tag = view.deploy?.tag
  for (const environment of view.deploy?.environments ?? [])
    if (tag && (environment.status === 'ready' || environment.status === 'failed'))
      steps.push({
        action: 'deploy',
        label: `Deploy ${tag} to ${environment.name}`,
        environment: environment.name,
        tag,
      })
  return steps
}

const repoArg = z.string().min(1).describe('The repository, as forge:path')

const noRepo = (repo: string) =>
  new ToolError(`No readable repository ${repo}; pass forge:path, e.g. gitlab:group/app.`)

const modes: Record<ReleaseSettings['flow']['mode'], string> = {
  'merge-request': 'merge request flow',
  trunk: 'trunk flow',
  external: 'released by another tool',
}

const acceptance: Record<ReleaseSettings['acceptance'], string> = {
  none: 'nothing: merged changes can become a version right away',
  manual: 'a person accepts in the panel, chat, API or release_step',
  label: 'the `release-accepted` label on the merged candidate (a person can also accept)',
  merge: 'merging the candidate (a person can also accept)',
}

/** The release flow of a repository in plain language. */
function renderReleaseRules(repo: string, settings: ReleaseSettings, guide: string): string {
  const { flow, version, deploy, gates } = settings
  const target = flow.target ?? 'the default branch'
  const lines = [
    `# How \`${repo}\` releases`,
    settings.enabled
      ? `Releases are on: ${modes[flow.mode]}.`
      : `Releases are off for this repository (${modes[flow.mode]} configured).`,
    flow.mode === 'merge-request'
      ? `- Changes land on \`${flow.source}\`; a release candidate merge request brings them into \`${target}\`, where versions are tagged.`
      : flow.mode === 'trunk'
        ? `- Changes land on \`${target}\` directly; versions are tagged there.`
        : '- Another tool tags versions; Holtkeeper only shows them.',
    `- Versions: ${version.scheme === 'semver' ? 'semantic versions' : 'calendar versions YYYY.MM.N (UTC)'}, tagged \`${version.tagFormat}\`${version.prerelease ? ', release candidates first (1.2.0-rc.1, rc.2, ...)' : ''}.`,
    ...(version.scheme === 'semver'
      ? [
          '- The bump comes from commit conventions: a breaking change (`feat!:` or a `BREAKING CHANGE:` footer) is major (minor while the major version is 0), `feat` is minor, anything else patch. Leading ticket keys such as `[ABC-1] feat: ...` are skipped.',
        ]
      : []),
    `- Acceptance: ${acceptance[settings.acceptance]}.`,
    `- Gates: ${[
      gates.pipeline ? 'a failed or canceled pipeline blocks the step' : 'pipelines do not block',
      ...(gates.blockingLabels.length
        ? [
            `open merge requests labelled ${gates.blockingLabels.map((label) => `\`${label}\``).join(', ')} block releasing`,
          ]
        : []),
    ].join('; ')}.`,
    ...(settings.changelog.excludeTypes.length
      ? [
          `- Changelog leaves out ${settings.changelog.excludeTypes.map((type) => `\`${type}\``).join(', ')} commits.`,
        ]
      : []),
    ...(settings.changelogFile ? ['- Each version prepends its notes to CHANGELOG.md.'] : []),
    deploy.environments.length
      ? `- Environments, in order: ${deploy.environments
          .map(
            (env) =>
              `\`${env.name}\`${env.after ? ` after ${env.after}` : ''}${env.job && env.job !== env.name ? ` (job \`${env.job}\`)` : ''}`,
          )
          .join(', ')}.`
      : '- No deploy environments are configured.',
  ]
  return [
    lines.join('\n'),
    guide ? `## Team notes on releases\n\n${guide}` : 'No team notes on releases yet.',
  ].join('\n\n')
}

/** A gate in a sentence, marked when failing it only warns. */
const gateText = (gate: GateResult) =>
  gate.severity === 'block' ? gate.message : `${gate.message} (${gate.severity})`

/** What runs on an environment, e.g. `staging v1.2.0 (success)`. */
const environmentText = (env: EnvironmentSummary) =>
  `${env.name} ${env.tag ?? 'nothing yet'} (${env.status})`

/** The release state of a repository, with the next allowed steps. */
function renderReleaseStatus(repo: string, view: ReleaseRepoView, anonymous: boolean): string {
  const { row } = view
  const plan = view.version ?? view.proposal
  const failing = [...(view.proposal?.gates ?? []), ...(view.version?.gates ?? [])].filter(
    (gate) => !gate.ok && !(gate.severity === 'block' && row.blockers.includes(gate.message)),
  )
  const steps = nextReleaseSteps(view)
  const lines = [
    `# Release status of \`${repo}\``,
    `${stageText(row)}.${view.settings.enabled ? '' : ' Releases are off for this repository.'}${view.dryRun ? ' Dry run: steps change nothing.' : ''}`,
    ...(row.error ? [`Error: ${row.error}`] : []),
    `- Latest: ${row.latest ? `\`${row.latest.tag}\`${row.latest.date ? ` (${row.latest.date.slice(0, 10)})` : ''}` : 'none'}`,
    ...(row.next
      ? [
          `- Next: \`${row.next}\`${row.bump ? ` (${row.bump})` : ''}${plan?.suggested.reasons.length ? ` because ${plan.suggested.reasons.map((reason) => reason.because).join('; ')}` : ''}`,
        ]
      : []),
    `- Unreleased on ${row.target ?? 'the target'}: ${row.unreleased}${row.unreleasedCapped ? '+' : ''} commits`,
    ...(row.source && row.mode === 'merge-request'
      ? [`- Ahead on ${row.source}: ${row.ahead}${row.aheadCapped ? '+' : ''} commits`]
      : []),
    ...(row.request
      ? [`- Candidate: !${row.request.id} ${row.request.title} ${row.request.webUrl}`]
      : []),
    ...(row.acceptance
      ? [
          `- Accepted by ${anonymous ? `a person (via ${row.acceptance.via})` : (row.acceptance.name ?? row.acceptance.by)} at ${row.acceptance.at}`,
        ]
      : []),
    ...(row.blockers.length ? [`- Blockers: ${row.blockers.join('; ')}`] : []),
    ...(failing.length ? [`- Failing gates: ${failing.map(gateText).join('; ')}`] : []),
    ...(row.environments.length
      ? [`- Environments: ${row.environments.map(environmentText).join(', ')}`]
      : []),
    ...(view.deploy?.environments.length
      ? [
          `- Deploy of ${view.deploy.tag}: ${view.deploy.environments.map((env) => `${env.name} ${env.status}`).join(', ')}`,
        ]
      : []),
    steps.length
      ? `Next allowed steps: ${steps.map((step) => `${step.label} (action ${step.action}${step.environment ? `, environment ${step.environment}` : ''})`).join('; ')}.`
      : 'No step waits.',
  ]
  return lines.join('\n')
}

const taskLine = (task: ReleaseTask) => {
  const key = task.url ? `[${task.key}](${task.url})` : task.key
  const issue = task.issue
  if (!issue) return `- ${key} ${task.titles[0] ?? ''} (${task.commits} commits)`.trimEnd()
  const meta = [issue.type, issue.status].filter(Boolean).join(', ')
  return `- ${key} ${issue.title}${meta ? ` [${meta}]` : ''} (${task.commits} commits)`
}

/** Tasks and the grouped changelog of a range. */
function renderReleaseChanges(repo: string, changes: ReleaseChanges): string {
  return [
    `# Changes of \`${repo}\`: ${changes.from ?? 'start'} → ${changes.to}${changes.unreleased ? ' (next release)' : ''}`,
    `${changes.commitCount}${changes.capped ? '+' : ''} commits, bump ${changes.bump}.${changes.compareUrl ? ` Compare: ${changes.compareUrl}` : ''}`,
    `## Tasks (${changes.tasks.length})`,
    changes.tasks.length
      ? changes.tasks.map(taskLine).join('\n')
      : 'No tracker keys in these commits.',
    '## Changelog',
    changes.changelog.trim() || 'No changes.',
  ].join('\n\n')
}

const renderPreview = (preview: ReleaseStepPreview, confirm: string | undefined) =>
  [
    `# ${preview.title}`,
    ...preview.fields.map((field) => `- ${field.label}: ${field.value}`),
    ...(preview.failing.length
      ? [`Failing gates: ${preview.failing.map(gateText).join('; ')}`]
      : []),
    preview.blocked
      ? `Blocked: ${preview.blocked}`
      : `Nothing has changed yet. To run it, call release_step again with the same arguments and confirm: "${confirm}" (valid 10 minutes, once). Ask the user first.`,
  ].join('\n')

function readTools(access: ReleaseToolsAccess): RegistryTool[] {
  const repoOf = (value: string) => {
    const repo = access.repoOf(value)
    if (!repo) throw noRepo(value)
    return repo
  }
  return [
    defineTool({
      name: 'release_rules',
      description:
        "How a repository releases, in plain language: branches, merge request or trunk flow, tag format and version scheme, how the bump is derived from commit conventions, acceptance, gates, environments in order, and the team's notes on releases from its Guide.",
      input: z.object({ repo: repoArg }),
      run: async ({ repo }) => {
        const target = repoOf(repo)
        const [settings, guide] = await Promise.all([access.settings(target), access.guide(target)])
        return renderReleaseRules(repo, settings, guide)
      },
      subject: ({ repo }) => repo,
    }),
    defineTool({
      name: 'release_status',
      description:
        'Where a repository is in its release flow: stage, latest version, suggested next version and why, unreleased commits, the release candidate merge request, acceptance, blockers and failing gates, the version on each environment, deploy state per environment and the steps allowed next.',
      input: z.object({ repo: repoArg }),
      run: async ({ repo }) =>
        renderReleaseStatus(repo, await access.status(repoOf(repo)), access.anonymous === true),
      subject: ({ repo }) => repo,
    }),
    defineTool({
      name: 'release_changes',
      description:
        'Tasks (tracker keys, with tracker titles and status when a tracker is connected) and the grouped changelog between two versions. Default range: the latest version → the target branch, which is the next release; with only `to`, the version before it → `to`.',
      input: z.object({
        repo: repoArg,
        from: z
          .string()
          .min(1)
          .optional()
          .describe('Exclusive start: a version or tag such as 1.4.0 or v1.4.0'),
        to: z
          .string()
          .min(1)
          .optional()
          .describe('End: a version or tag; default the target branch (unreleased changes)'),
      }),
      run: async ({ repo, from, to }) =>
        renderReleaseChanges(
          repo,
          await access.changes(repoOf(repo), {
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          }),
        ),
      subject: ({ repo }) => repo,
    }),
  ]
}

function stepTools(
  access: ReleaseToolsAccess,
  steps: NonNullable<ReleaseToolsAccess['steps']>,
): RegistryTool[] {
  return [
    defineTool({
      name: 'release_step',
      description:
        'Runs one release step: propose (open or update the release candidate), accept, version (tag the next version) or deploy (start an environment). The first call without confirm only previews and returns a one-time confirm token; the second call with the same arguments and that token runs it. Show the preview to the user and run it only when they agree.',
      input: z.object({
        repo: repoArg,
        action: z.enum(['propose', 'accept', 'version', 'deploy']),
        environment: z.string().min(1).optional().describe('deploy: the environment'),
        tag: z
          .string()
          .min(1)
          .optional()
          .describe('deploy: the version tag; default the latest version'),
        override: z
          .boolean()
          .optional()
          .describe('Run although soft gates fail; only when the user asked for it'),
        writeNotes: z
          .boolean()
          .optional()
          .describe('propose: have the AI write the release notes first'),
        note: z
          .string()
          .max(500)
          .optional()
          .describe('accept: why the changes are accepted; deploy: why it is deployed'),
        confirm: z
          .string()
          .min(1)
          .optional()
          .describe('The token from the preview; omit to preview'),
      }),
      readOnly: false,
      run: async ({ repo, confirm, ...input }) => {
        const target = access.repoOf(repo)
        if (!target) throw noRepo(repo)
        const stepInput: ReleaseStepInput = {
          action: input.action,
          ...(input.environment ? { environment: input.environment } : {}),
          ...(input.tag ? { tag: input.tag } : {}),
          ...(input.override ? { override: true } : {}),
          ...(input.writeNotes ? { writeNotes: true } : {}),
          ...(input.note ? { note: input.note } : {}),
        }
        if (!confirm) {
          const { preview, confirm: token } = await steps.preview(target, stepInput)
          return renderPreview(preview, token)
        }
        const result = await steps.run(target, stepInput, confirm)
        return `${result.dryRun ? 'Dry run: ' : ''}${result.detail}${result.url ? ` ${result.url}` : ''}`
      },
      subject: ({ repo }) => repo,
    }),
  ]
}

/**
 * The `releases` toolset: `release_rules`, `release_status` and `release_changes` over the
 * repositories `access` lets the caller read, plus `release_step` (preview, then a confirm token)
 * when `access.steps` is set.
 */
export function releasesToolset(access: ReleaseToolsAccess): RegistryToolset {
  return {
    name: 'releases',
    instructions:
      'Before releasing, call release_rules and release_status; release_changes lists tasks and the changelog between versions.' +
      (access.steps ? ' Never pass override to release_step unless the user asked.' : ''),
    tools: [...readTools(access), ...(access.steps ? stepTools(access, access.steps) : [])],
  }
}
