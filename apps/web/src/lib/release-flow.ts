import type { ReleaseSettings, RepoRef, SettingView } from '@holtkeeper/api'

import type { FlowEdgeSpec, FlowNodeSpec } from './flow.ts'
import { repoKey } from './repo.ts'

type Environment = ReleaseSettings['deploy']['environments'][number]

/** The nodes of a release flow diagram; each opens a drawer with only its own fields. */
export type ReleaseFlowNode =
  | FlowNodeSpec<'branch', { role: 'source' | 'target'; name: string; gated: boolean }>
  | FlowNodeSpec<'request', { labels: string[]; acceptance: ReleaseSettings['acceptance'] }>
  | FlowNodeSpec<'tag', { example: string; scheme: ReleaseSettings['version']['scheme'] }>
  | FlowNodeSpec<'external', Record<string, never>>
  | FlowNodeSpec<'environment', { index: number; environment: Environment }>

const acceptanceLabels: Record<ReleaseSettings['acceptance'], string | undefined> = {
  none: undefined,
  manual: 'accepted by a person',
  label: 'accepted by label',
  merge: 'accepted on merge',
}

/** A tag name the settings would produce, e.g. `v1.4.0` or `release-2026.11.0-rc.1`. */
export const exampleTag = (version: ReleaseSettings['version']): string =>
  version.tagFormat.replace(
    '{version}',
    `${version.scheme === 'semver' ? '1.4.0' : '2026.11.0'}${version.prerelease ? '-rc.1' : ''}`,
  )

const environmentNodeId = (index: number) => `env:${index}`

/**
 * The release flow as a diagram, from the settings alone: merge request mode is
 * `source → release MR → target → tag → environments`, trunk mode `target → tag → environments`,
 * external mode one node for the outside tool followed by the environments. An environment with
 * `after` hangs off that environment, the others off the tag. `defaultBranch` names the target
 * when the settings leave it empty.
 */
export function releaseFlowGraph(
  settings: ReleaseSettings,
  defaultBranch = 'default branch',
): { nodes: ReleaseFlowNode[]; edges: FlowEdgeSpec[] } {
  const { flow, version, acceptance, gates } = settings
  const nodes: ReleaseFlowNode[] = []
  const edges: FlowEdgeSpec[] = []
  const gated = gates.pipeline || gates.blockingLabels.length > 0
  const accepted = acceptanceLabels[acceptance]
  let release = 'tag'
  if (flow.mode === 'external') {
    nodes.push({ id: 'external', kind: 'external', data: {}, width: 220 })
    release = 'external'
  } else {
    const target = flow.target ?? defaultBranch
    if (flow.mode === 'merge-request') {
      nodes.push(
        { id: 'source', kind: 'branch', data: { role: 'source', name: flow.source, gated } },
        {
          id: 'request',
          kind: 'request',
          data: { labels: settings.mergeRequest.labels, acceptance },
        },
      )
      edges.push(
        { from: 'source', to: 'request', label: 'propose' },
        { from: 'request', to: 'target', label: accepted ?? 'merge' },
      )
    }
    nodes.push(
      { id: 'target', kind: 'branch', data: { role: 'target', name: target, gated } },
      { id: 'tag', kind: 'tag', data: { example: exampleTag(version), scheme: version.scheme } },
    )
    edges.push({
      from: 'target',
      to: 'tag',
      label: flow.mode === 'trunk' && accepted ? accepted : 'version',
    })
  }
  const environments = settings.deploy.environments
  const names = new Set(environments.map((env) => env.name))
  environments.forEach((environment, index) => {
    const id = environmentNodeId(index)
    nodes.push({ id, kind: 'environment', data: { index, environment } })
    const after =
      environment.after && environment.after !== environment.name && names.has(environment.after)
        ? environmentNodeId(environments.findIndex((env) => env.name === environment.after))
        : undefined
    edges.push({
      from: after ?? release,
      to: id,
      ...(environment.confirm ? {} : { label: 'no confirm' }),
      ...(after ? { dashed: true } : {}),
    })
  })
  return { nodes, edges }
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

/**
 * The `releases` setting that names exactly this repository, to update it in place instead of
 * adding another entry; matched by `forge:path` or by the bare path.
 */
export function repoReleaseEntry(
  entries: readonly SettingView[] | undefined,
  repo: RepoRef,
): SettingView | undefined {
  const names = [repoKey(repo), repo.path]
  return entries?.find(
    (entry) =>
      entry.key === 'releases' &&
      !entry.scope.all &&
      !entry.scope.groups?.length &&
      entry.scope.repos?.length === 1 &&
      names.includes(entry.scope.repos[0]!),
  )
}
