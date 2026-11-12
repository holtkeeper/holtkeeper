import type { Job, RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { GitPullRequestArrow, RotateCcw } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useJobAnalyzers, useJobMutations, useRepos } from '../../api/queries.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { mergeRequestNumber, reviewJobInput } from '../../lib/reviews.ts'
import { Button, Dialog, Notice, Placeholder, Select, TextField, notify } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

const queued = (job: Job, what: string) =>
  notify.success(
    'Review queued',
    <>
      {what} ·{' '}
      <Link to="/ops/runs/$jobId" params={{ jobId: job.id }} className="underline">
        open the job
      </Link>
    </>,
  )

/** Whether the viewer may queue reviews: `analyses:run` and a `review` analyzer jobs can run. */
export function useCanReview(): boolean {
  const { can } = useSession()
  const analyzers = useJobAnalyzers()
  return (
    can('analyses:run') &&
    (analyzers.data?.analyzers.some((analyzer) => analyzer.kind === 'review') ?? false)
  )
}

function RepoField({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (value: string) => void
}) {
  const repos = useRepos()
  if (repos.isPending) return <Placeholder className="h-14" />
  if (repos.isError)
    return (
      <Notice tone="danger" title="Repositories not loaded">
        {messageOf(repos.error)}
      </Notice>
    )
  return (
    <Select
      label="Repository"
      placeholder="Pick a repository…"
      options={repos.data.repos.map(({ repo }) => ({
        id: repoKey(repo),
        label: repo.path,
        text: repo.path,
      }))}
      value={value}
      onChange={onChange}
    />
  )
}

function ReviewForm({ repo, onClose }: { repo: RepoRef | undefined; onClose: () => void }) {
  const { create } = useJobMutations()
  const [picked, setPicked] = useState<string | undefined>()
  const [text, setText] = useState('')
  const target = repo ?? parseRepoKey(picked)
  const number = mergeRequestNumber(text)
  const submit = () => {
    if (!target || number === undefined) return
    create.mutate(reviewJobInput(target, number), {
      onSuccess: (job) => {
        queued(job, `!${number} of ${target.path}`)
        onClose()
      },
    })
  }
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title="Review a merge request"
      description={
        repo
          ? `Holtkeeper reviews a merge request of ${repo.path} and posts its findings there.`
          : 'Holtkeeper reviews the merge request and posts its findings there.'
      }
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onPress={submit}
            isDisabled={!target || number === undefined}
            isPending={create.isPending}
          >
            <GitPullRequestArrow className="size-3.5" />
            Queue review
          </Button>
        </>
      }
    >
      {create.error ? (
        <Notice tone="danger" title="Not queued">
          {messageOf(create.error)}
        </Notice>
      ) : null}
      {repo ? null : <RepoField value={picked} onChange={setPicked} />}
      <TextField
        label="Merge request"
        value={text}
        onChange={setText}
        mono
        autoFocus={repo !== undefined}
        placeholder="!42 or a merge request URL"
        error={text.trim() && number === undefined ? 'Type a number or a link' : undefined}
        description="The guide and review settings of the repository apply."
      />
    </Dialog>
  )
}

/** Queues the `review` analyzer for one merge request; `repo` fixes the repository. */
export function ReviewMergeRequestDialog({
  isOpen,
  onOpenChange,
  repo,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  repo?: RepoRef
}) {
  if (!isOpen) return null
  return <ReviewForm repo={repo} onClose={() => onOpenChange(false)} />
}

function AgainForm({
  repo,
  mergeRequest,
  onClose,
}: {
  repo: RepoRef
  mergeRequest: { iid: number; title: string }
  onClose: () => void
}) {
  const { create } = useJobMutations()
  const submit = () =>
    create.mutate(reviewJobInput(repo, mergeRequest.iid, true), {
      onSuccess: (job) => {
        queued(job, `!${mergeRequest.iid} of ${repo.path}`)
        onClose()
      },
    })
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      size="sm"
      title="Review again"
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onPress={submit} isPending={create.isPending}>
            <RotateCcw className="size-3.5" />
            Review again
          </Button>
        </>
      }
    >
      {create.error ? (
        <Notice tone="danger" title="Not queued">
          {messageOf(create.error)}
        </Notice>
      ) : null}
      <p className="text-[13px]">
        <span className="mono text-muted">!{mergeRequest.iid}</span> {mergeRequest.title}
      </p>
      <p className="text-xs text-muted">
        Holtkeeper reviews the merge request again even when its head commit was reviewed already.
        The run spends AI budget and may post new comments.
      </p>
    </Dialog>
  )
}

/** Queues the `review` analyzer again for a reviewed merge request, with `force` set. */
export function ReviewAgainDialog({
  isOpen,
  onOpenChange,
  repo,
  mergeRequest,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  repo: RepoRef
  mergeRequest: { iid: number; title: string }
}) {
  if (!isOpen) return null
  return <AgainForm repo={repo} mergeRequest={mergeRequest} onClose={() => onOpenChange(false)} />
}
