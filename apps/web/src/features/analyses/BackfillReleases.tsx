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
 * Queues a changelog for each of the newest tags of one repository (or of every repository) that
 * has none yet, optionally with a release risk assessment. Hidden without `analyses:run` or jobs.
 */
export function BackfillReleasesButton({
  repo,
  variant = 'secondary',
}: {
  repo?: RepoRef | undefined
  variant?: ButtonVariant
}) {
  const { can } = useSession()
  const analyzers = useJobAnalyzers()
  const backfill = useBackfillReleases()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState<(typeof limits)[number]>('20')
  const [risk, setRisk] = useState(false)
  const kinds = analyzers.data?.analyzers.map((a) => a.kind) ?? []
  if (!can('analyses:run') || !analyzers.data?.enabled || !kinds.includes('changelog')) return null

  const submit = () =>
    backfill.mutate(
      { ...(repo ? { repo: repoKey(repo) } : {}), limit: Number(limit), risk },
      {
        onSuccess: (result) => {
          setOpen(false)
          notify.success(
            result.queued ? `${result.queued} jobs queued` : 'Nothing new to analyze',
            `${result.tags} tags in ${result.repos} ${result.repos === 1 ? 'repository' : 'repositories'}, ${result.skipped} already analyzed or queued${result.errors.length ? `, ${result.errors.length} failed` : ''}`,
          )
          if (result.queued)
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
          Queues a changelog for each of the newest tags that has none yet, oldest first, so the
          Releases page fills with history. Jobs of one repository run one after another; the queue
          is on the Jobs page.
        </p>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm">Newest tags per repository</span>
          <Segmented
            aria-label="Tags per repository"
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
                  One more job per tag; it uses the AI for summaries when one is configured.
                </span>
              </span>
            }
            isSelected={risk}
            onChange={setRisk}
          />
        ) : null}
      </Dialog>
    </>
  )
}
