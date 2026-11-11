import type { PipelineStatus } from '@holtkeeper/forge'

import type { DeployState, ReleaseFacts } from './types.ts'

/** URLs into a forge's web UI. */
export interface ChangelogLinks {
  commit(sha: string): string
  compare(from: string, to: string): string
  mergeRequest(number: number): string
  tag(name: string): string
  /** `#123` goes to the forge's issues, `ABC-123` to the ticket template when there is one. */
  ticket(id: string): string | undefined
}

export interface ForgeLinksOptions {
  kind: 'gitlab' | 'github'
  /** Project page, e.g. `https://gitlab.example.com/group/project`. */
  webUrl: string
  /** Tracker URL with `{id}`, e.g. `https://tracker.example.com/browse/{id}`. */
  ticketUrl?: string
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
    name in values ? encodeURI(values[name] ?? '') : whole,
  )

/** Links into a GitLab or GitHub project. */
export function forgeLinks({ kind, webUrl, ticketUrl }: ForgeLinksOptions): ChangelogLinks {
  const base = webUrl.replace(/\/+$/u, '')
  const templates =
    kind === 'gitlab'
      ? {
          commit: `${base}/-/commit/{sha}`,
          compare: `${base}/-/compare/{from}...{to}`,
          mergeRequest: `${base}/-/merge_requests/{n}`,
          tag: `${base}/-/tags/{name}`,
          issue: `${base}/-/issues/{n}`,
        }
      : {
          commit: `${base}/commit/{sha}`,
          compare: `${base}/compare/{from}...{to}`,
          mergeRequest: `${base}/pull/{n}`,
          tag: `${base}/releases/tag/{name}`,
          issue: `${base}/issues/{n}`,
        }
  return {
    commit: (sha) => fill(templates.commit, { sha }),
    compare: (from, to) => fill(templates.compare, { from, to }),
    mergeRequest: (n) => fill(templates.mergeRequest, { n: String(n) }),
    tag: (name) => fill(templates.tag, { name }),
    ticket(id) {
      const issue = /^#(\d+)$/u.exec(id)
      if (issue) return fill(templates.issue, { n: issue[1] ?? '' })
      return ticketUrl ? fill(ticketUrl, { id }) : undefined
    },
  }
}

/** What a `ReleaseLink` points at. */
export type ReleaseLinkKind =
  | 'merge-request'
  | 'blocker'
  | 'tag'
  | 'compare'
  | 'pipeline'
  | 'repository'
  | 'merge-requests'
  | 'branches'
  | 'tags'
  | 'releases'
  | 'pipelines'
  | 'environments'

/**
 * A link to the forge: `current` ones name this release's objects (candidate, merged and blocking
 * merge requests, the latest tag, unreleased and candidate diffs, pipelines), `pages` the
 * project's lists.
 */
export interface ReleaseLink {
  kind: ReleaseLinkKind
  group: 'current' | 'pages'
  label: string
  url: string
  /** Pipelines only. */
  status?: PipelineStatus
}

/** Links of a repository's release state on GitLab or GitHub, current objects first. */
export function releaseLinks(
  kind: 'gitlab' | 'github',
  facts: ReleaseFacts,
  deploy?: DeployState,
): ReleaseLink[] {
  const base = facts.webUrl.replace(/\/+$/u, '')
  const templates = forgeLinks({ kind, webUrl: base })
  const page =
    kind === 'gitlab' ? (path: string) => `${base}/-/${path}` : (path: string) => `${base}/${path}`
  const current: Omit<ReleaseLink, 'group'>[] = []

  if (facts.request)
    current.push({
      kind: 'merge-request',
      label: `Candidate !${facts.request.id}`,
      url: facts.request.webUrl,
    })
  if (facts.merged && facts.unreleased.length > 0)
    current.push({
      kind: 'merge-request',
      label: `Merged !${facts.merged.id}`,
      url: facts.merged.webUrl,
    })
  for (const blocker of facts.blockers)
    current.push({ kind: 'blocker', label: `Blocker !${blocker.id}`, url: blocker.webUrl })
  if (facts.latest)
    current.push({ kind: 'tag', label: facts.latest.tag, url: templates.tag(facts.latest.tag) })
  if (facts.latest && facts.unreleased.length > 0)
    current.push({
      kind: 'compare',
      label: `${facts.latest.tag}…${facts.target.name}`,
      url: templates.compare(facts.latest.tag, facts.target.name),
    })
  if (facts.source && facts.ahead.length > 0)
    current.push({
      kind: 'compare',
      label: `${facts.target.name}…${facts.source.name}`,
      url: templates.compare(facts.target.name, facts.source.name),
    })
  const pipelines = [
    { name: facts.source?.name, pipeline: facts.pipelines.source },
    { name: facts.target.name, pipeline: facts.pipelines.target },
    { name: deploy?.tag, pipeline: deploy?.pipeline },
  ]
  for (const { name, pipeline } of pipelines)
    if (name && pipeline)
      current.push({
        kind: 'pipeline',
        label: `${name} pipeline`,
        url: pipeline.webUrl,
        status: pipeline.status,
      })

  const pages: Omit<ReleaseLink, 'group'>[] = [
    { kind: 'repository', label: 'Repository', url: base },
    {
      kind: 'merge-requests',
      label: kind === 'gitlab' ? 'Merge requests' : 'Pull requests',
      url: page(kind === 'gitlab' ? 'merge_requests' : 'pulls'),
    },
    { kind: 'branches', label: 'Branches', url: page('branches') },
    { kind: 'tags', label: 'Tags', url: page('tags') },
    { kind: 'releases', label: 'Releases', url: page('releases') },
    {
      kind: 'pipelines',
      label: kind === 'gitlab' ? 'Pipelines' : 'Actions',
      url: page(kind === 'gitlab' ? 'pipelines' : 'actions'),
    },
    {
      kind: 'environments',
      label: kind === 'gitlab' ? 'Environments' : 'Deployments',
      url: page(kind === 'gitlab' ? 'environments' : 'deployments'),
    },
  ]

  return [
    ...current.map((link) => ({ ...link, group: 'current' as const })),
    ...pages.map((link) => ({ ...link, group: 'pages' as const })),
  ]
}
