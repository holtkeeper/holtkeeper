import type { StorageProviderView, SystemHealth } from '@holtkeeper/api'
import { formatBytes } from '@holtkeeper/api'
import { HardDrive, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useClearStorage, useStorage } from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import {
  clearedMessage,
  shareLabel,
  shareOf,
  sortProviders,
  storageDelta,
  storageShade,
} from '../../lib/storage.ts'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Legend,
  Placeholder,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { SystemPanel } from './SystemPanel.tsx'

const th = 'border-b border-line px-3 py-2 text-left text-[11.5px] font-medium text-muted'
const td = 'border-b border-line px-3 py-2 align-middle'

const trendColor = { up: 'text-muted', down: 'text-ok', flat: 'text-muted' } as const

function AreaRow({
  provider,
  totalBytes,
  maxBytes,
  shade,
  weekAgo,
  onClear,
}: {
  provider: StorageProviderView
  totalBytes: number
  maxBytes: number
  shade: string
  weekAgo: number | undefined
  onClear?: () => void
}) {
  const delta = provider.available ? storageDelta(provider.bytes, weekAgo) : undefined
  return (
    <tr className={provider.available ? '' : 'opacity-70'}>
      <td className={td}>
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="size-[9px] shrink-0 rounded-[2px]"
            style={{ background: shade }}
          />
          <span className="font-medium">{provider.label}</span>
          {provider.available ? null : <span className="text-xs text-dim">Not used</span>}
        </div>
        {provider.note ? (
          <div className="mono truncate ps-[17px] text-[11.5px] text-dim" title={provider.note}>
            {provider.note}
          </div>
        ) : null}
        {provider.error ? (
          <div className="flex items-center gap-1 ps-[17px] text-[11.5px] text-bad">
            <TriangleAlert aria-hidden className="size-3" />
            Could not measure: {provider.error}
          </div>
        ) : null}
      </td>
      <td className={`${td} text-right`}>
        <span className="mono">{provider.available ? formatBytes(provider.bytes) : '—'}</span>
      </td>
      <td className={`${td} text-right`}>
        <span className="mono text-muted">
          {provider.count !== undefined ? provider.count.toLocaleString('en-US') : '—'}
        </span>
      </td>
      <td className={td}>
        <div className="flex items-center gap-2">
          <span className="h-[5px] w-[90px] shrink-0 overflow-hidden rounded-[3px] bg-line">
            <span
              className="block h-full rounded-[3px]"
              style={{
                width: `${provider.bytes > 0 ? Math.max(3, (provider.bytes / maxBytes) * 100) : 0}%`,
                background: shade,
              }}
            />
          </span>
          <span className="mono text-[11.5px] text-dim">
            {shareLabel(provider.bytes, totalBytes)}
          </span>
        </div>
      </td>
      <td className={`${td} text-right`}>
        {delta ? (
          <span className={`mono ${trendColor[delta.trend]}`}>{delta.text}</span>
        ) : (
          <span className="text-dim">—</span>
        )}
      </td>
      <td className={`${td} text-right`}>
        {onClear && provider.available && provider.clearable ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Clear ${provider.label}`}
            onPress={onClear}
          >
            <Trash2 className="size-3.5" />
            Clear
          </Button>
        ) : null}
      </td>
    </tr>
  )
}

/**
 * Settings › System › Storage and caches: the total over every area with its change in seven
 * days (from `health`), a stacked bar with a legend, and a table of areas with size, items, share,
 * weekly change and Clear for caches when the viewer has a global `settings:write`.
 */
export function Storage({ health }: { health: SystemHealth | undefined }) {
  const { canGlobal } = useSession()
  const storage = useStorage()
  const clear = useClearStorage()
  const [clearing, setClearing] = useState<StorageProviderView | null>(null)
  const writable = canGlobal('settings:write')
  const providers = sortProviders(storage.data?.providers ?? [])
  const totalBytes = storage.data?.totalBytes ?? 0
  const measured = providers.filter((provider) => provider.available && provider.bytes > 0)
  const shadeOf = new Map(providers.map((provider, index) => [provider.id, storageShade(index)]))
  const maxBytes = Math.max(1, ...providers.map((provider) => provider.bytes))
  const weekAgo = health?.storage.weekAgo
  const totalDelta = storageDelta(totalBytes, health?.storage.weekAgoBytes)

  return (
    <SystemPanel
      id="storage"
      title="Storage and caches"
      description="Space used by the store, artifacts, caches and checkouts"
      aside={
        storage.data ? (
          <span>
            <b className="mono text-[15px] font-semibold text-foreground">
              {formatBytes(totalBytes)}
            </b>{' '}
            in {plural(providers.length, 'area')}
            {totalDelta ? (
              <>
                {' · '}
                <span className="mono text-foreground">{totalDelta.text}</span> in 7 days
              </>
            ) : null}
          </span>
        ) : null
      }
    >
      {storage.isPending ? (
        <div className="flex flex-col gap-3 p-3.5">
          <Placeholder className="h-3" />
          <Placeholder className="h-40" />
        </div>
      ) : storage.isError ? (
        <div className="p-3.5">
          <ErrorState error={storage.error} />
        </div>
      ) : providers.length === 0 ? (
        <EmptyState icon={<HardDrive />} title="No storage areas reported" />
      ) : (
        <>
          {measured.length ? (
            <div className="flex flex-col gap-2.5 px-3.5 py-3">
              <div
                className="flex h-2.5 gap-0.5 overflow-hidden rounded-[5px]"
                role="img"
                aria-label={`Share of storage by area: ${measured
                  .map((p) => `${p.label} ${shareLabel(p.bytes, totalBytes)}`)
                  .join(', ')}`}
              >
                {measured.map((provider) => (
                  <i
                    key={provider.id}
                    className="block h-full"
                    style={{
                      flex: `${shareOf(provider.bytes, totalBytes)} 1 0`,
                      background: shadeOf.get(provider.id),
                    }}
                  />
                ))}
              </div>
              <Legend
                label="Storage areas"
                items={measured.map((provider) => ({
                  label: provider.label,
                  color: shadeOf.get(provider.id) ?? storageShade(0),
                }))}
              />
            </div>
          ) : null}
          <div className="grid border-t border-line xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="overflow-x-auto">
              <table aria-label="Storage areas" className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    <th scope="col" className={th}>
                      Area
                    </th>
                    <th scope="col" className={`${th} text-right`}>
                      Size
                    </th>
                    <th scope="col" className={`${th} text-right`}>
                      Items
                    </th>
                    <th scope="col" className={th}>
                      Share
                    </th>
                    <th scope="col" className={`${th} text-right`}>
                      7 days
                    </th>
                    <th scope="col" className={th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="[&>tr:last-child>td]:border-b-0">
                  {providers.map((provider) => (
                    <AreaRow
                      key={provider.id}
                      provider={provider}
                      totalBytes={totalBytes}
                      maxBytes={maxBytes}
                      shade={shadeOf.get(provider.id) ?? storageShade(0)}
                      weekAgo={weekAgo?.[provider.id]}
                      {...(writable ? { onClear: () => setClearing(provider) } : {})}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col gap-2 border-t border-line px-3.5 py-3 xl:border-s xl:border-t-0">
              <span className="text-[11.5px] font-medium text-muted">What Clear does</span>
              <p className="m-0 text-xs leading-normal text-muted">
                Only caches can be cleared. The space is freed on every worker within seconds;
                Holtkeeper rebuilds what it needs on the next run, which may take longer. Records,
                logs and the store are never cleared here.
              </p>
              {health?.storage.since ? (
                <p className="m-0 text-[11.5px] text-dim">
                  Weekly change against the snapshot of{' '}
                  <span className="mono">{health.storage.since}</span>.
                </p>
              ) : (
                <p className="m-0 text-[11.5px] text-dim">
                  Weekly change appears once a daily snapshot is a week old.
                </p>
              )}
            </div>
          </div>
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
    </SystemPanel>
  )
}
