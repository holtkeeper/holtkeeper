import type {
  DeployState,
  PipelineState,
  ReleaseLink,
  ReleaseLinkKind,
  ReleaseBoardRow,
  ReleaseBump,
  RepoRef,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  FolderGit2,
  GitBranch,
  GitCompare,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  OctagonAlert,
  Package,
  Server,
  Tag,
  Tags,
  Workflow,
} from 'lucide-react'
import type { ReactNode } from 'react'

import {
  bumpTones,
  deployLabels,
  deployTones,
  stageLabels,
  stageTones,
} from '../../lib/releases.ts'
import { repoKey, splitRepoPath } from '../../lib/repo.ts'
import { Chip, Tooltip } from '../../ui/index.ts'
import { RepoAvatar } from '../repos/RepoAvatar.tsx'

/** Repository avatar and name linking to its release page. */
export function ReleaseRepoLink({ repo }: { repo: RepoRef }) {
  const { namespace, name } = splitRepoPath(repo.path)
  return (
    <div className="flex items-center gap-3">
      <RepoAvatar repo={repo} size="sm" />
      <Link
        to="/release-board/repo"
        search={{ repo: repoKey(repo) }}
        className="min-w-0 truncate hover:underline"
        title={repo.path}
      >
        <span className="text-muted">{namespace}</span>
        <span className="font-semibold">{name}</span>
      </Link>
    </div>
  )
}

export function StageChip({ stage }: { stage: ReleaseBoardRow['stage'] }) {
  return <Chip tone={stageTones[stage]}>{stageLabels[stage]}</Chip>
}

export function BumpChip({ bump }: { bump: ReleaseBump }) {
  return bump === 'none' ? null : (
    <Chip tone={bumpTones[bump]} variant="tertiary">
      {bump}
    </Chip>
  )
}

const pipelineIcon = (status: PipelineState['status']) => {
  if (status === 'success') return <CircleCheck className="size-4 text-success" />
  if (status === 'failed' || status === 'canceled')
    return <CircleX className="size-4 text-danger" />
  if (status === 'running' || status === 'pending')
    return <LoaderCircle className="size-4 animate-spin text-accent" />
  return <CircleDashed className="size-4 text-muted" />
}

/** A pipeline's status as an icon linking to it. */
export function PipelineDot({
  label,
  pipeline,
}: {
  label: string
  pipeline?: PipelineState | undefined
}) {
  if (!pipeline) return null
  return (
    <Tooltip content={`${label}: pipeline ${pipeline.status}`}>
      <a
        href={pipeline.webUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={`${label} pipeline ${pipeline.status}`}
      >
        {pipelineIcon(pipeline.status)}
      </a>
    </Tooltip>
  )
}

/** Compact deploy states of a version: one chip per environment. */
export function DeployChips({ deploy }: { deploy?: DeployState | undefined }) {
  if (!deploy?.environments.length) return <span className="text-muted">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {deploy.environments.map((env) => (
        <Tooltip
          key={env.name}
          content={`${deploy.tag} on ${env.name}: ${deployLabels[env.status]}`}
        >
          <span tabIndex={0}>
            <Chip tone={deployTones[env.status]}>
              {env.name}
              {env.status === 'running' || env.status === 'pending' ? (
                <LoaderCircle className="ml-1 size-3 animate-spin" />
              ) : null}
            </Chip>
          </span>
        </Tooltip>
      ))}
    </div>
  )
}

const linkIcons: Record<ReleaseLinkKind, ReactNode> = {
  'merge-request': <GitMerge className="size-3.5" />,
  blocker: <OctagonAlert className="size-3.5 text-danger" />,
  tag: <Tag className="size-3.5" />,
  compare: <GitCompare className="size-3.5" />,
  pipeline: <Workflow className="size-3.5" />,
  repository: <FolderGit2 className="size-3.5" />,
  'merge-requests': <GitPullRequest className="size-3.5" />,
  branches: <GitBranch className="size-3.5" />,
  tags: <Tags className="size-3.5" />,
  releases: <Package className="size-3.5" />,
  pipelines: <Workflow className="size-3.5" />,
  environments: <Server className="size-3.5" />,
}

function ReleaseLinkItem({ link }: { link: ReleaseLink }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      title={link.status ? `${link.label}: ${link.status}` : link.url}
      className={`inline-flex items-center gap-1.5 rounded-full border border-separator px-2.5 py-1 text-xs hover:bg-default ${link.group === 'pages' ? 'text-muted' : ''}`}
    >
      {link.status ? pipelineIcon(link.status) : linkIcons[link.kind]}
      {link.label}
    </a>
  )
}

/** Forge links of a release: its merge requests, tags, diffs and pipelines, then project pages. */
export function ReleaseLinks({ links }: { links: readonly ReleaseLink[] }) {
  if (!links.length) return null
  const current = links.filter((link) => link.group === 'current')
  const pages = links.filter((link) => link.group === 'pages')
  return (
    <nav aria-label="Forge links" className="flex flex-col gap-2">
      {current.length ? (
        <div className="flex flex-wrap gap-1.5">
          {current.map((link) => (
            <ReleaseLinkItem key={`${link.kind}-${link.url}`} link={link} />
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {pages.map((link) => (
          <ReleaseLinkItem key={link.kind} link={link} />
        ))}
      </div>
    </nav>
  )
}
