import type { RepoRef } from '@holtkeeper/api'
import { useNavigate } from '@tanstack/react-router'
import { History } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useBackfillAnalyses, useJobAnalyzers } from '../../api/queries.ts'
import { repoKey } from '../../lib/repo.ts'
import type { ButtonVariant } from '../../ui/Button.tsx'
import { Button, Dialog, type MoreMenuItem, Segmented, notify } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

const limits = ['10', '20', '50', '100'] as const

const explanations = {
  'api-surface':
    'Snapshots the exports of every package at each of the newest releases that has none yet, oldest first, so agents can read any version and this page can diff them.',
  bundle:
    'Builds each of the newest releases that has no record yet and downloads the package versions it published, oldest first, so this page shows how sizes changed. Old releases that no longer build show as gaps.',
}

/**
 * Queues `analyzer` for each of the newest releases of one repository (or of every repository)
 * it has not analyzed yet; the server lists tags in the background. `item` is an "Analyze past
 * releases" entry for a "⋯" menu that opens the dialog, `dialog` the dialog to render. Without
 * `analyses:run`, jobs or the analyzer there is no `item`.
 */
export function useBackfillReleases(
  analyzer: keyof typeof explanations,
  repo?: RepoRef,
): { item?: MoreMenuItem; dialog: ReactNode } {
  const { can } = useSession()
  const analyzers = useJobAnalyzers()
  const backfill = useBackfillAnalyses()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState<(typeof limits)[number]>('20')
  const kinds = analyzers.data?.analyzers.map((a) => a.kind) ?? []
  if (!can('analyses:run') || !analyzers.data || !kinds.includes(analyzer)) return { dialog: null }

  const submit = () =>
    backfill.mutate(
      { analyzer, ...(repo ? { repo: repoKey(repo) } : {}), limit: Number(limit) },
      {
        onSuccess: () => {
          setOpen(false)
          notify.success(
            'Looking for past releases',
            'Jobs appear in Ops › Runs as each repository is listed; the outcome shows up in Settings › Audit log.',
          )
          void navigate({ to: '/ops/runs', search: repo ? { repo: repoKey(repo) } : {} })
        },
        onError: (error) => notify.error('Not queued', messageOf(error)),
      },
    )

  return {
    item: { label: 'Analyze past releases', icon: History, onAction: () => setOpen(true) },
    dialog: (
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
          {explanations[analyzer]} A commit tagging several monorepo packages is one release.
          Repositories are listed in the background; the queue is in Ops › Runs.
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
      </Dialog>
    ),
  }
}

/** `useBackfillReleases` as a button; renders nothing when the hook offers no entry. */
export function BackfillReleasesButton({
  analyzer,
  repo,
  variant = 'secondary',
}: {
  analyzer: keyof typeof explanations
  repo?: RepoRef | undefined
  variant?: ButtonVariant
}) {
  const { item, dialog } = useBackfillReleases(analyzer, repo)
  if (!item) return null
  return (
    <>
      <Button variant={variant} onPress={item.onAction}>
        <History className="size-3.5" />
        {item.label}
      </Button>
      {dialog}
    </>
  )
}
