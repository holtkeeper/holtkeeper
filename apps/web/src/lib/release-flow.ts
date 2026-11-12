import type { FlowDetection, ReleaseSettings, RepoRef, SettingView } from '@holtkeeper/api'

import { repoKey } from './repo.ts'

type Environment = ReleaseSettings['deploy']['environments'][number]
type DetectionSource = FlowDetection['provenance'][string]

/** A tag name the settings would produce, e.g. `v1.4.0` or `release-2026.11.0-rc.1`. */
export const exampleTag = (version: ReleaseSettings['version']): string =>
  version.tagFormat.replace(
    '{version}',
    `${version.scheme === 'semver' ? '1.4.0' : '2026.11.0'}${version.prerelease ? '-rc.1' : ''}`,
  )

/** The three steps of the release setup, in order. */
export type SetupStep = 'flow' | 'versions' | 'deploy'

/** The setup steps in order, each with its label and hint. */
export const setupSteps: readonly { id: SetupStep; label: string; hint: string }[] = [
  { id: 'flow', label: 'Flow', hint: 'Branches, acceptance and gates' },
  { id: 'versions', label: 'Versions', hint: 'Tags and changelog' },
  { id: 'deploy', label: 'Environments', hint: 'Deploy jobs, order and confirmation' },
]

/** The setup step that edits a settings path such as `flow.source` or `deploy.environments.0.name`. */
export function stepOfPath(path: string): SetupStep {
  const head = path.split('.')[0]
  if (head === 'version' || head === 'changelog' || head === 'changelogFile') return 'versions'
  if (head === 'deploy') return 'deploy'
  return 'flow'
}

type Mode = ReleaseSettings['flow']['mode']
type Acceptance = ReleaseSettings['acceptance']

/** Flow modes in the order the setup offers them. */
export const modes: readonly Mode[] = ['merge-request', 'trunk', 'external']

/** Acceptance choices in the order the setup offers them. */
export const acceptances: readonly Acceptance[] = ['none', 'manual', 'label', 'merge']

/** Each flow mode in words. */
export const modeLabels: Record<Mode, string> = {
  'merge-request': 'Release merge request',
  trunk: 'Trunk',
  external: 'External tool',
}

/** Each acceptance choice in words. */
export const acceptanceLabels: Record<Acceptance, string> = {
  none: 'Nothing (a person may still accept)',
  manual: 'A person, in the panel or API',
  label: 'The release-accepted label on the merged MR',
  merge: 'Merging the release MR',
}

const acceptanceShort: Record<Acceptance, string> = {
  none: 'no acceptance',
  manual: 'accepted by a person',
  label: 'accepted by label',
  merge: 'accepted by merging',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const record = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const flag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const texts = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined

const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined =>
  options.find((option) => option === value)

const valueAt = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((current, key) => record(current)?.[key], value)

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .toSorted()
            .map((key) => [key, canonical(value[key])]),
        )
      : value

const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

function suggestedEnvironments(value: unknown): Environment[] | undefined {
  const list = record(value)?.['environments']
  if (!Array.isArray(list)) return undefined
  return list.flatMap((item): Environment[] => {
    const env = record(item)
    const name = str(env?.['name'])
    if (!env || !name) return []
    const job = str(env['job'])
    const after = str(env['after'])
    return [
      {
        name,
        confirm: flag(env['confirm']) ?? true,
        ...(job ? { job } : {}),
        ...(after ? { after } : {}),
      },
    ]
  })
}

/**
 * The settings with a detection's suggestions laid over them: each suggested section replaces
 * the fields it names and keeps the others (suggested environments replace the list), and a
 * suggested flow drops the current target unless it names one. Values of the wrong shape are
 * ignored.
 */
export function applyDetection(
  settings: ReleaseSettings,
  detection: Pick<FlowDetection, 'settings'>,
): ReleaseSettings {
  const suggested = detection.settings
  const flow = record(suggested['flow'])
  const version = record(suggested['version'])
  const gates = record(suggested['gates'])
  const labels = texts(record(suggested['mergeRequest'])?.['labels'])
  const environments = suggestedEnvironments(suggested['deploy'])
  const target = str(flow?.['target'])
  const { target: _target, ...keptFlow } = settings.flow
  return {
    ...settings,
    flow: flow
      ? {
          ...keptFlow,
          mode: oneOf(modes, flow['mode']) ?? settings.flow.mode,
          source: str(flow['source']) ?? settings.flow.source,
          ...(target ? { target } : {}),
        }
      : settings.flow,
    version: {
      scheme: oneOf(['semver', 'calver'], version?.['scheme']) ?? settings.version.scheme,
      tagFormat: str(version?.['tagFormat']) ?? settings.version.tagFormat,
      prerelease: flag(version?.['prerelease']) ?? settings.version.prerelease,
    },
    acceptance: oneOf(acceptances, suggested['acceptance']) ?? settings.acceptance,
    changelogFile: flag(suggested['changelogFile']) ?? settings.changelogFile,
    mergeRequest: labels ? { ...settings.mergeRequest, labels } : settings.mergeRequest,
    deploy: environments ? { ...settings.deploy, environments } : settings.deploy,
    gates: {
      pipeline: flag(gates?.['pipeline']) ?? settings.gates.pipeline,
      blockingLabels: texts(gates?.['blockingLabels']) ?? settings.gates.blockingLabels,
    },
  }
}

/**
 * Where a draft field's value comes from: `detected` while it equals a suggestion that has
 * evidence, `edited` once it differs from what the page started with, otherwise `saved` for a
 * configured repository and `default` for one without settings.
 */
export type FieldSource = 'detected' | 'edited' | 'saved' | 'default'

/** Where the draft value at `path` comes from (see `FieldSource`). */
export function fieldSource(
  path: string,
  context: {
    draft: ReleaseSettings
    start: ReleaseSettings
    detection?: Pick<FlowDetection, 'settings' | 'provenance'> | undefined
    configured: boolean
  },
): FieldSource {
  const { draft, start, detection, configured } = context
  const value = valueAt(draft, path)
  if (detection?.provenance[path] && same(valueAt(detection.settings, path), value))
    return 'detected'
  if (!same(value, valueAt(start, path))) return 'edited'
  return configured ? 'saved' : 'default'
}

/** One source for several fields shown together: edited wins, then detected. */
export function combinedSource(sources: readonly FieldSource[]): FieldSource {
  for (const source of ['edited', 'detected', 'saved'] as const)
    if (sources.includes(source)) return source
  return 'default'
}

/**
 * What blocks saving a draft, by settings path: a missing source branch or one equal to the
 * target, a tag format without `{version}`, environments without a name or with a taken one.
 */
export function draftErrors(draft: ReleaseSettings): Record<string, string> {
  const errors: Record<string, string> = {}
  if (draft.flow.mode === 'merge-request') {
    const source = draft.flow.source.trim()
    if (!source) errors['flow.source'] = 'Required'
    else if (source === draft.flow.target?.trim())
      errors['flow.target'] = 'Must differ from the source branch'
  }
  if (!draft.version.tagFormat.includes('{version}'))
    errors['version.tagFormat'] = 'Must contain {version}'
  const seen = new Set<string>()
  draft.deploy.environments.forEach((environment, index) => {
    const name = environment.name.trim()
    if (!name) errors[`deploy.environments.${index}.name`] = 'Required'
    else if (seen.has(name))
      errors[`deploy.environments.${index}.name`] = 'Another environment has this name'
    seen.add(name)
  })
  return errors
}

/** The first step that has an error, to send the person back to it. */
export const firstErrorStep = (errors: Record<string, string>): SetupStep | undefined =>
  setupSteps.find((step) => Object.keys(errors).some((path) => stepOfPath(path) === step.id))?.id

/**
 * The draft as it is saved: names and branches trimmed, an empty target, tracker URL or deploy
 * job left out, and `after`s that name no other environment dropped.
 */
export function cleanSettings(draft: ReleaseSettings): ReleaseSettings {
  const { target, ...flow } = draft.flow
  const { ticketUrl, ...changelog } = draft.changelog
  const names = new Set(draft.deploy.environments.map((env) => env.name.trim()))
  const environments = draft.deploy.environments.map((env): Environment => {
    const { job, after, ...rest } = env
    const name = env.name.trim()
    return {
      ...rest,
      name,
      ...(job?.trim() ? { job: job.trim() } : {}),
      ...(after && after !== name && names.has(after) ? { after } : {}),
    }
  })
  return {
    ...draft,
    flow: {
      ...flow,
      source: flow.source.trim(),
      ...(target?.trim() ? { target: target.trim() } : {}),
    },
    changelog: { ...changelog, ...(ticketUrl?.trim() ? { ticketUrl: ticketUrl.trim() } : {}) },
    deploy: { ...draft.deploy, environments },
  }
}

/**
 * Settings with the environment at `index` replaced, or removed when `next` is undefined. A
 * rename carries over to the environments deployed after it; a removal drops those `after`s.
 */
export function withEnvironment(
  settings: ReleaseSettings,
  index: number,
  next: Environment | undefined,
): ReleaseSettings {
  const current = settings.deploy.environments[index]
  if (!current) return settings
  const environments = settings.deploy.environments.flatMap((env, at) => {
    if (at === index) return next ? [next] : []
    if (env.after !== current.name) return [env]
    if (next) return [{ ...env, after: next.name }]
    const { after: _dropped, ...rest } = env
    return [rest]
  })
  return { ...settings, deploy: { ...settings.deploy, environments } }
}

/** Settings with one more environment, named after the common ones and deployed after the last. */
export function addEnvironment(settings: ReleaseSettings): ReleaseSettings {
  const existing = settings.deploy.environments
  const taken = new Set(existing.map((env) => env.name))
  let counter = existing.length + 1
  while (taken.has(`environment-${counter}`)) counter++
  const name =
    ['staging', 'production'].find((candidate) => !taken.has(candidate)) ?? `environment-${counter}`
  const last = existing.at(-1)
  const environment: Environment = { name, confirm: true, ...(last ? { after: last.name } : {}) }
  return { ...settings, deploy: { ...settings.deploy, environments: [...existing, environment] } }
}

/** One step of the flow strip: a branch, the release MR, the tag or an environment. */
export interface FlowStripItem {
  id: string
  step: SetupStep
  title: string
  detail: string
  /** Settings paths the item shows, for its source badge. */
  paths: string[]
  mono: boolean
}

/** The draft flow as three groups left to right: branches, tags and environments. */
export function flowStrip(
  settings: ReleaseSettings,
  defaultBranch = 'default branch',
): { label: string; items: FlowStripItem[] }[] {
  const { flow, version, acceptance, gates } = settings
  const branches: FlowStripItem[] = []
  const target = flow.target?.trim() || defaultBranch
  const gateCount = (gates.pipeline ? 1 : 0) + gates.blockingLabels.length
  const gateText = gateCount === 1 ? '1 gate' : `${gateCount} gates`
  const targetPaths = ['flow.target', 'gates.pipeline', 'gates.blockingLabels']
  if (flow.mode === 'external') {
    branches.push({
      id: 'external',
      step: 'flow',
      title: 'External tool',
      detail: 'tags versions outside Holtkeeper',
      paths: ['flow.mode'],
      mono: false,
    })
  } else if (flow.mode === 'merge-request') {
    const labels = settings.mergeRequest.labels
    branches.push(
      {
        id: 'source',
        step: 'flow',
        title: flow.source,
        detail: 'source',
        paths: ['flow.mode', 'flow.source'],
        mono: true,
      },
      {
        id: 'request',
        step: 'flow',
        title: 'Release MR',
        detail: `${labels.length ? `label ${labels.join(', ')}` : 'no labels'} · ${acceptanceShort[acceptance]}`,
        paths: ['mergeRequest.labels', 'acceptance'],
        mono: false,
      },
      {
        id: 'target',
        step: 'flow',
        title: target,
        detail: `target · ${gateText}`,
        paths: targetPaths,
        mono: true,
      },
    )
  } else {
    branches.push({
      id: 'target',
      step: 'flow',
      title: target,
      detail: `trunk · ${acceptanceShort[acceptance]} · ${gateText}`,
      paths: ['flow.mode', 'acceptance', ...targetPaths],
      mono: true,
    })
  }
  const tags: FlowStripItem[] =
    flow.mode === 'external'
      ? []
      : [
          {
            id: 'tag',
            step: 'versions',
            title: exampleTag(version),
            detail: `${version.scheme === 'semver' ? 'semantic' : 'calendar'} · ${version.tagFormat}`,
            paths: ['version.scheme', 'version.tagFormat'],
            mono: true,
          },
        ]
  const environments = settings.deploy.environments.map((env, index): FlowStripItem => ({
    id: `env:${index}`,
    step: 'deploy',
    title: env.name || 'unnamed',
    detail: [
      env.job?.trim() || env.name,
      env.after ? `after ${env.after}` : 'right after the tag',
      ...(env.confirm ? ['asks first'] : []),
    ].join(' · '),
    paths: ['deploy.environments'],
    mono: true,
  }))
  return [
    { label: 'Branches', items: branches },
    ...(tags.length ? [{ label: 'Tags', items: tags }] : []),
    { label: 'Environments', items: environments },
  ]
}

const pathLabels: Record<string, string> = {
  'flow.mode': 'Flow',
  'flow.source': 'Source branch',
  'flow.target': 'Target branch',
  'version.scheme': 'Scheme',
  'version.tagFormat': 'Tag format',
  'mergeRequest.labels': 'Release MR labels',
  acceptance: 'Accepted by',
  changelogFile: 'CHANGELOG.md',
  'deploy.environments': 'Environments',
  'gates.pipeline': 'Pipeline gate',
}

function suggestionText(path: string, detection: Pick<FlowDetection, 'settings'>): string {
  const label = pathLabels[path] ?? path
  const value = valueAt(detection.settings, path)
  let text = ''
  const mode = oneOf(modes, value)
  const acceptance = oneOf(acceptances, value)
  if (path === 'flow.mode' && mode) text = modeLabels[mode]
  else if (path === 'acceptance' && acceptance) text = acceptanceShort[acceptance]
  else if (path === 'version.scheme') text = value === 'calver' ? 'calendar' : 'semantic'
  else if (path === 'changelogFile') text = value ? 'prepend the notes' : 'off'
  else if (path === 'gates.pipeline') text = value ? 'a failed pipeline blocks' : 'off'
  else if (Array.isArray(value))
    text = value
      .map((item) => (record(item) ? String(record(item)?.name) : String(item)))
      .join(', ')
  else if (typeof value === 'string') text = value
  return text ? `${label}: ${text}` : label
}

/** One row of "What we read": a piece of evidence and the settings it suggests. */
export interface SignalRow {
  kind: DetectionSource['kind']
  what: string
  note: string
  where: string
  at?: string
  suggests: string[]
}

const kindOrder: readonly DetectionSource['kind'][] = [
  'tag',
  'merge-request',
  'label',
  'file',
  'commits',
  'pipeline-job',
  'branch',
]

const percent = (share: number) => `${Math.round(share * 100)}%`

/**
 * Everything detection read, one row per piece of evidence, each with the suggested settings it
 * backs (`Source branch: develop`). Evidence that only backs a suggestion (a merge request, a
 * tag) gets its own row; rows are ordered tags, merge requests, labels, files, commits, deploy
 * jobs, branches.
 */
export function signalRows(detection: FlowDetection): SignalRow[] {
  const { signals, provenance } = detection
  const rows: SignalRow[] = []
  const add = (row: Omit<SignalRow, 'suggests'>, suggests: string[] = []) => {
    const created = { ...row, suggests }
    rows.push(created)
    return created
  }
  for (const label of signals.releaseLabels)
    add({
      kind: 'label',
      what: label.name,
      note: `on ${label.mergeRequests} of ${label.of} merge requests`,
      where: 'labels',
    })
  if (signals.changelog)
    add({
      kind: 'file',
      what: signals.changelog,
      note: 'at the repository root',
      where: provenance['changelogFile']?.where ?? '',
    })
  const { conventional, tracker } = signals
  if (conventional.sampled)
    add({
      kind: 'commits',
      what: percent(conventional.share),
      note: `of ${conventional.sampled} ${conventional.where} follow Conventional Commits`,
      where: conventional.where,
    })
  if (tracker.sampled)
    add({
      kind: 'commits',
      what: percent(tracker.share),
      note: `of ${tracker.sampled} ${tracker.where} carry a tracker key${
        tracker.keys.length ? ` (${tracker.keys.slice(0, 3).join(', ')})` : ''
      }`,
      where: tracker.where,
    })
  const environments = provenance['deploy.environments'] !== undefined
  for (const job of signals.deployJobs)
    add(
      {
        kind: 'pipeline-job',
        what: job.name,
        note: `${job.manual ? 'manual' : 'automatic'}, stage ${job.stage}`,
        where: job.ref,
        ...(job.at ? { at: job.at } : {}),
      },
      environments ? [`Environment: ${job.environment}`] : [],
    )
  if (signals.targetBranch)
    add({
      kind: 'branch',
      what: signals.targetBranch.name,
      note: signals.targetBranch.protected ? 'protected' : 'not protected',
      where: 'branches',
    })
  for (const [path, source] of Object.entries(provenance)) {
    if (source.kind === 'pipeline-job') continue
    const row =
      rows.find(
        (candidate) =>
          candidate.kind === source.kind &&
          candidate.what === source.value &&
          (candidate.kind !== 'merge-request' || candidate.where === source.where),
      ) ??
      add({
        kind: source.kind,
        what: source.value,
        note: '',
        where: source.where,
        ...(source.at ? { at: source.at } : {}),
      })
    const text = suggestionText(path, detection)
    if (!row.suggests.includes(text)) row.suggests.push(text)
  }
  return rows.toSorted((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind))
}

/**
 * The `releases` setting that names exactly this repository, to update it in place instead of
 * adding another entry; matched by `forge:path` or by the bare path.
 */
export function repoReleaseEntry(
  entries: readonly SettingView[] | undefined,
  repo: RepoRef,
): SettingView | undefined {
  const names = new Set([repoKey(repo), repo.path])
  return entries?.find(
    (entry) =>
      entry.key === 'releases' &&
      !entry.scope.all &&
      !entry.scope.groups?.length &&
      entry.scope.repos?.length === 1 &&
      names.has(entry.scope.repos[0]!),
  )
}
