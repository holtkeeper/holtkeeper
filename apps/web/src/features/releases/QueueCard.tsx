import type { ReleaseCard } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ArrowRight, BadgeCheck, Pencil } from 'lucide-react'

import { messageOf } from '../../api/client.ts'
import { useReleaseActions } from '../../api/queries.ts'
import { formatRelative } from '../../lib/format.ts'
import {
  environmentStatus,
  overviewState,
  overviewTag,
  targetPipeline,
} from '../../lib/release-overview.ts'
import { countLabel } from '../../lib/releases.ts'
import { repoKey } from '../../lib/repo.ts'
import { Button, Dot, LinkButton, Tag, notify } from '../../ui/index.ts'
import { RepoLink } from '../repos/RepoLink.tsx'
import { BumpTag } from './parts.tsx'

function Gate({ card }: { card: ReleaseCard }) {
  if (card.blockers.length)
    return (
      <p className="flex items-baseline gap-1.5 text-xs">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-bad">
          <Dot tone="danger" />
          Blocked
        </span>
        <span className="min-w-0 text-muted">{card.blockers.join(' · ')}</span>
      </p>
    )
  const pipeline = targetPipeline(card)
  return (
    <p className="flex items-baseline gap-1.5 text-xs">
      <span className="inline-flex shrink-0 items-center gap-1.5">
        <Dot tone={pipeline.tone} />
        {pipeline.label}
      </span>
      <span className="text-muted">
        pipeline on <span className="mono">{card.target ?? 'target'}</span> · nothing blocks the
        version
      </span>
    </p>
  )
}

/**
 * One repository that needs a person, as a card of the release queue: current → next version
 * with its bump and why, what waits, the gates, where each environment stands and the step to
 * take. **Accept** shows only when `card.can.accept` (`releases:run` on the repository).
 */
export function QueueCard({ card }: { card: ReleaseCard }) {
  const actions = useReleaseActions()
  const state = overviewState(card)
  const tag = overviewTag(card)
  const search = { repo: repoKey(card.repo) }
  return (
    <article
      aria-label={`Next release of ${card.repo.path}`}
      className="flex min-w-0 flex-col gap-2.5 rounded-[10px] border border-line bg-sunk p-3"
    >
      <header className="flex items-start justify-between gap-2">
        <RepoLink repo={card.repo} to="/releases/timeline" />
        <Tag tone={tag.tone} dot>
          {tag.label}
        </Tag>
      </header>
      {card.error ? (
        <p className="text-xs text-bad">{card.error}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {card.latest ? (
              <>
                <span className="mono text-dim">{card.latest.version}</span>
                <ArrowRight aria-label="to" className="size-3.5 text-dim" />
              </>
            ) : null}
            <span className="mono text-[20px] font-semibold tracking-tight">
              {card.next ?? card.latest?.version ?? 'no version'}
            </span>
            <BumpTag bump={card.bump} />
            {card.waitingSince ? (
              <span className="ms-auto text-xs text-dim">
                waiting {formatRelative(card.waitingSince)}
              </span>
            ) : null}
          </div>
          {card.reasons.length ? (
            <p className="text-xs text-muted">{card.reasons.join(' · ')}</p>
          ) : null}
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {card.unreleased ? (
              <span>
                <b className="tabular font-semibold text-foreground">
                  {countLabel(card.unreleased, card.unreleasedCapped, 'commit')}
                </b>{' '}
                unreleased on <span className="mono">{card.target}</span>
              </span>
            ) : null}
            <span>
              <b className="tabular font-semibold text-foreground">{card.tasks}</b>{' '}
              {card.tasks === 1 ? 'task' : 'tasks'}
            </span>
            <span>
              <b className="tabular font-semibold text-foreground">{card.leftOut}</b> left out
            </span>
          </p>
          <Gate card={card} />
        </>
      )}
      {card.environments.length ? (
        <ul aria-label="Environments" className="grid grid-cols-2 gap-1.5">
          {card.environments.map((env) => {
            const status = environmentStatus[env.status]
            return (
              <li
                key={env.name}
                className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-line bg-panel px-2 py-1.5"
              >
                <span className="mono truncate text-[11.5px] text-muted">{env.name}</span>
                <span className="flex items-center gap-1.5 text-xs">
                  <Dot tone={status.tone} />
                  {status.label}
                  {env.version ? (
                    <span className="mono truncate text-dim">{env.version}</span>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      <footer className="flex flex-wrap items-center gap-2">
        {state === 'acceptance' && card.can.accept ? (
          <Button
            size="sm"
            variant="secondary"
            isPending={actions.accept.isPending}
            onPress={() =>
              actions.accept.mutate(
                { repo: repoKey(card.repo) },
                {
                  onSuccess: (result) => notify.success(result.detail),
                  onError: (error) => notify.error('Not accepted', messageOf(error)),
                },
              )
            }
          >
            <BadgeCheck className="size-3.5" />
            Accept {card.next}
          </Button>
        ) : null}
        {card.can.run && !card.error ? (
          <LinkButton to="/releases/timeline" search={search} variant="ghost" size="sm">
            <Pencil className="size-3.5" />
            Edit notes
          </LinkButton>
        ) : null}
        <Link
          to="/releases/timeline"
          search={search}
          className="ms-auto inline-flex items-center gap-1 text-xs hover:underline"
        >
          Review changes
          <ArrowRight className="size-3" />
        </Link>
      </footer>
    </article>
  )
}
