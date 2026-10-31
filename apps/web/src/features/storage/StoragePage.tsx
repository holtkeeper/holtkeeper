import type { StorageProviderView } from '@holtkeeper/api'
import { formatBytes } from '@holtkeeper/api'
import { HardDrive, Trash2, TriangleAlert } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useClearStorage, useStorage } from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import { clearedMessage, shareOf, sortProviders } from '../../lib/storage.ts'
import {
  AnimatedNumber,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  fadeItem,
  notify,
  stagger,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

const seriesColor = (index: number) => `var(--series-${(index % 8) + 1})`

function ProviderPanel({
  provider,
  totalBytes,
  color,
  onClear,
}: {
  provider: StorageProviderView
  totalBytes: number
  color: string
  onClear?: () => void
}) {
  const detailMax = Math.max(1, ...provider.details.map((detail) => detail.bytes))
  return (
    <motion.li
      {...fadeItem}
      className={`flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-surface ${provider.available ? '' : 'opacity-70'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-default"
            style={{ color }}
          >
            <HardDrive className="size-4.5" />
          </span>
          <div className="min-w-0">
            <div className="truncate font-medium">{provider.label}</div>
            <div className="truncate font-mono text-xs text-muted">{provider.id}</div>
          </div>
        </div>
        {provider.available ? (
          <div className="text-right">
            <div className="text-xl font-semibold tracking-tight">
              <AnimatedNumber value={provider.bytes} format={formatBytes} />
            </div>
            <div className="text-xs text-muted">
              {provider.count !== undefined ? `${plural(provider.count, 'item')} · ` : ''}
              {Math.round(shareOf(provider.bytes, totalBytes))}% of total
            </div>
          </div>
        ) : (
          <Chip>Not used</Chip>
        )}
      </div>

      {provider.error ? (
        <div className="flex items-start gap-2 rounded-xl bg-danger-soft p-2.5 text-xs text-danger-soft-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">Could not measure: {provider.error}</span>
        </div>
      ) : null}
      {provider.note ? <p className="text-xs text-muted">{provider.note}</p> : null}

      {provider.available && provider.details.length ? (
        <ul className="flex flex-col gap-2">
          {provider.details.map((detail) => (
            <li key={detail.label} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-mono text-[13px]">{detail.label}</span>
                <span className="tabular shrink-0 text-xs text-muted">
                  {formatBytes(detail.bytes)}
                  {detail.count !== undefined ? ` · ${detail.count}` : ''}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-default">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(detail.bytes / detailMax) * 100}%`, background: color }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {onClear && provider.available && provider.clearable ? (
        <div className="mt-auto flex justify-end border-t border-separator pt-3">
          <Button variant="ghost" size="sm" onPress={onClear}>
            <Trash2 className="size-3.5" />
            Clear
          </Button>
        </div>
      ) : null}
    </motion.li>
  )
}

/** Disk and database space per storage area, with clearing for caches that allow it. */
export function StoragePage() {
  const { can } = useSession()
  const storage = useStorage()
  const clear = useClearStorage()
  const [clearing, setClearing] = useState<StorageProviderView | null>(null)
  const writable = can('settings:write')
  const providers = sortProviders(storage.data?.providers ?? [])
  const totalBytes = storage.data?.totalBytes ?? 0
  const colorOf = new Map(providers.map((provider, index) => [provider.id, seriesColor(index)]))
  const measured = providers.filter((provider) => provider.available && provider.bytes > 0)

  return (
    <Page
      title="Storage"
      icon="storage"
      description="Space used by the database, artifacts, caches and checkouts"
    >
      {storage.isPending ? (
        <div className="flex flex-col gap-4">
          <Placeholder className="h-28" />
          <div className="grid gap-4 md:grid-cols-2">
            <Placeholder className="h-40" />
            <Placeholder className="h-40" />
          </div>
        </div>
      ) : storage.isError ? (
        <ErrorState error={storage.error} />
      ) : providers.length === 0 ? (
        <EmptyState icon={<HardDrive />} title="No storage areas reported" />
      ) : (
        <>
          <Panel title="Total" description={plural(providers.length, 'area')}>
            <div className="flex flex-col gap-3">
              <div className="text-3xl font-semibold tracking-tight">
                <AnimatedNumber value={totalBytes} format={formatBytes} />
              </div>
              {measured.length ? (
                <>
                  <div
                    className="flex h-3 overflow-hidden rounded-full bg-default"
                    role="img"
                    aria-label={measured
                      .map((p) => `${p.label} ${formatBytes(p.bytes)}`)
                      .join(', ')}
                  >
                    {measured.map((provider) => (
                      <motion.div
                        key={provider.id}
                        className="h-full"
                        style={{ background: colorOf.get(provider.id) }}
                        initial={{ width: 0 }}
                        animate={{ width: `${shareOf(provider.bytes, totalBytes)}%` }}
                        transition={{ type: 'spring', stiffness: 140, damping: 24 }}
                      />
                    ))}
                  </div>
                  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
                    {measured.map((provider) => (
                      <li key={provider.id} className="flex items-center gap-1.5">
                        <span
                          className="size-2 rounded-full"
                          style={{ background: colorOf.get(provider.id) }}
                        />
                        {provider.label}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </Panel>

          <motion.ul {...stagger} className="grid gap-4 md:grid-cols-2">
            {providers.map((provider) => (
              <ProviderPanel
                key={provider.id}
                provider={provider}
                totalBytes={totalBytes}
                color={colorOf.get(provider.id) ?? seriesColor(0)}
                {...(writable ? { onClear: () => setClearing(provider) } : {})}
              />
            ))}
          </motion.ul>
        </>
      )}

      <ConfirmDialog
        isOpen={clearing !== null}
        onOpenChange={(open) => !open && setClearing(null)}
        title={`Clear ${clearing?.label ?? 'storage'}?`}
        confirmLabel="Clear"
        isPending={clear.isPending}
        onConfirm={() =>
          clearing &&
          clear.mutate(
            { id: clearing.id },
            {
              onSuccess: (result) => {
                notify.success(`${clearing.label} cleared`, clearedMessage(result))
                setClearing(null)
              },
              onError: (error) => notify.error('Clearing failed', messageOf(error)),
            },
          )
        }
      >
        {clearing ? `${formatBytes(clearing.bytes)} will be removed` : ''}
        {clearing?.reportedBy ? ' on every worker within seconds. ' : '. '}
        Holtkeeper rebuilds what it needs on the next run, which may take longer.
      </ConfirmDialog>
    </Page>
  )
}
