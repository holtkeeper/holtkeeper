import type { RepoRef } from '@holtkeeper/api'
import { useNavigate } from '@tanstack/react-router'
import { History } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useBackfillReleases, useJobAnalyzers } from '../../api/queries.ts'
import { repoKey } from '../../lib/repo.ts'
import type { ButtonVariant } from '../../ui/Button.tsx'
import { Button, Checkbox, Dialog, Segmented, notify } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

const limits = ['10', '20', '50', '100'] as const

/**
 * Queues a changelog for each of the newest releases of one repository (or of every repository)
 * that has none yet, optionally with a release risk assessment and a public API snapshot
 * (preselected with `api`); the server lists tags in the background. Hidden without
 * `analyses:run` or jobs.
 */
export function BackfillReleasesButton({
  repo,
  variant = 'secondary',
  api: apiByDefault = false,
}: {
  repo?: RepoRef | undefined
  variant?: ButtonVariant
  api?: boolean
}) {
  const { can } = useSession()
  const analyzers = useJobAnalyzers()
  const backfill = useBackfillReleases()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState<(typeof limits)[number]>('20')
  const [risk, setRisk] = useState(false)
  const [api, setApi] = useState(apiByDefault)
  const kinds = analyzers.data?.analyzers.map((a) => a.kind) ?? []
  if (!can('analyses:run') || !analyzers.data?.enabled || !kinds.includes('changelog')) return null

  const submit = () =>
    backfill.mutate(
      { ...(repo ? { repo: repoKey(repo) } : {}), limit: Number(limit), risk, api },
      {
        onSuccess: () => {
          setOpen(false)
          notify.success(
            'Looking for past releases',
            'Jobs appear on the Jobs page as each repository is listed; the outcome goes to the activity log.',
          )
          void navigate({ to: '/jobs', search: repo ? { repo: repoKey(repo) } : {} })
        },
        onError: (error) => notify.error('Not queued', messageOf(error)),
      },
    )

  return (
    <>
      <Button variant={variant} onPress={() => setOpen(true)}>
        <History className="size-3.5" />
        Analyze past releases
      </Button>
      <Dialog
        isOpen={open}
        onOpenChange={setOpen}
        title="Analyze past releases"
        description={repo ? repo.path : 'Every repository of every group'}
        footer={
          <>
            <Button variant="tertiary" onPress={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onPress={submit} isPending={backfill.isPending}>
              Queue jobs
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Queues a changelog for each of the newest releases that has none yet, oldest first, so the
          Releases page fills with history. A commit tagging several monorepo packages is one
          release. Repositories are listed in the background; the queue is on the Jobs page.
        </p>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm">Newest releases per repository</span>
          <Segmented
            aria-label="Releases per repository"
            value={limit}
            onChange={setLimit}
            options={limits.map((id) => ({ id, label: id }))}
          />
        </div>
        {kinds.includes('release-risk') ? (
          <Checkbox
            label={
              <span className="flex flex-col">
                <span>Also assess release risk</span>
                <span className="text-xs text-muted">
                  One more job per release without one; it uses the AI for summaries when one is
                  configured.
                </span>
              </span>
            }
            isSelected={risk}
            onChange={setRisk}
          />
        ) : null}
        {kinds.includes('api-surface') ? (
          <Checkbox
            label={
              <span className="flex flex-col">
                <span>Also snapshot the public API</span>
                <span className="text-xs text-muted">
                  Exports of every package at each release, so agents can read any version and the
                  API page can diff them.
                </span>
              </span>
            }
            isSelected={api}
            onChange={setApi}
          />
        ) : null}
      </Dialog>
    </>
  )
}
