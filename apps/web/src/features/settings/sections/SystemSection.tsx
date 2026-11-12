import type { SystemHealth } from '@holtkeeper/api'
import { RefreshCw } from 'lucide-react'

import { useSystemHealth } from '../../../api/settings-system.ts'
import { formatClock } from '../../../lib/audit-labels.ts'
import { formatRelease } from '../../../lib/settings-counters.ts'
import { ErrorState, Placeholder, Strip, type StripCell } from '../../../ui/index.ts'
import { Caches } from '../../caches/Caches.tsx'
import { DatabaseHealth } from '../../database/Database.tsx'
import { Storage } from '../../storage/Storage.tsx'
import { SystemPanel } from '../../storage/SystemPanel.tsx'
import { LibraryIndex } from '../LibraryIndex.tsx'
import { AllKeys, BackgroundWork } from '../ResolvedSettings.tsx'
import { useSectionHeader } from '../section-header.ts'

const tone = { ok: 'success', warn: 'warning', error: 'danger' } as const

function healthCells(health: SystemHealth): StripCell[] {
  return [
    ...health.checks.map((check): StripCell => ({
      tone: tone[check.status],
      prefix: check.label,
      value: check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'needs a look' : 'failing',
      label: check.detail ? `· ${check.detail}` : '',
    })),
    {
      end: true,
      value: formatClock(health.checkedAt),
      prefix: health.version ? `${formatRelease(health.version)} · checked` : 'checked',
      label: '',
    },
  ]
}

/** The health strip of Settings › System; the header's Check health now measures again. */
function HealthStrip() {
  const health = useSystemHealth()
  useSectionHeader({
    primary: {
      label: health.isFetching ? 'Checking…' : 'Check health now',
      icon: RefreshCw,
      isDisabled: health.isFetching,
      onPress: () => void health.refetch(),
    },
  })
  return (
    <div className="flex flex-col overflow-hidden rounded-[10px] border border-line bg-sunk">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <h2 className="text-[13.5px] font-semibold">Health</h2>
        <span className="text-xs text-muted">
          Store, migrations, artifacts, workers and the library index
        </span>
      </div>
      {health.isPending ? (
        <Placeholder className="m-3 h-5" />
      ) : health.isError ? (
        <div className="p-3">
          <ErrorState error={health.error} />
        </div>
      ) : (
        <Strip label="System health" cells={healthCells(health.data)} className="border-b-0" />
      )}
    </div>
  )
}

/**
 * Settings › System per the Graphite mockup: health at a glance, Storage and caches (with the
 * change over seven days), the egress proxy cache, Database, Library index, Background work and
 * All keys. Each block is a `SystemPanel` with the anchor the sub-navigation links to.
 */
export function SystemSection() {
  const health = useSystemHealth()
  return (
    <div className="flex flex-col gap-3.5">
      <HealthStrip />
      <Storage health={health.data} />
      <Caches />
      <DatabaseHealth />
      <LibraryIndex />
      <SystemPanel
        id="background"
        title="Background work"
        description="How often Holtkeeper looks for changes, which tool versions jobs use, and how stale analyses get swept"
      >
        <BackgroundWork />
      </SystemPanel>
      <SystemPanel
        id="advanced"
        title="All keys"
        description="Every setting with its winner and source"
      >
        <AllKeys />
      </SystemPanel>
    </div>
  )
}
