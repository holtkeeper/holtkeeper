import { forgeLinks } from '@holtkeeper/changelog'
import type { PipelineStatus } from '@holtkeeper/forge'

import type { DeployState, ReleaseFacts } from './types.ts'

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
