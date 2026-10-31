import type { EgressCacheEntry, EgressCacheKind, EgressCacheView } from '@holtkeeper/api'
import { formatBytes } from '@holtkeeper/api'
import { DatabaseZap, Package, Trash2, Wrench } from 'lucide-react'
import { motion } from 'motion/react'
import { useDeferredValue, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useDeleteEgressCache, useEgressCache } from '../../api/queries.ts'
import {
  cacheKinds,
  cacheTotals,
  entryHost,
  entryName,
  filterEntries,
  formatTtl,
  hitRate,
  hostTotals,
} from '../../lib/caches.ts'
import { formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import {
  AnimatedNumber,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Notice,
  Page,
  Panel,
  Placeholder,
  SearchInput,
  Segmented,
  Table,
  Td,
  Th,
  Tooltip,
  fadeItem,
  notify,
  stagger,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

type Loaded = Extract<EgressCacheView, { backend: unknown }>

const PAGE_SIZE = 200

const kindColor: Record<EgressCacheKind, string> = {
  packages: 'var(--series-1)',
  tools: 'var(--series-3)',
}

const kindIcon = { packages: Package, tools: Wrench } satisfies Record<EgressCacheKind, unknown>

/** What a delete request removes, as the confirmation names it. */
type Deletion =
  | { scope: 'entry'; entry: EgressCacheEntry }
  | { scope: 'kind'; kind: EgressCacheKind }
  | { scope: 'all' }

const deletionTitle = (deletion: Deletion) =>
  deletion.scope === 'entry'
    ? `Remove ${entryName(deletion.entry)}?`
    : deletion.scope === 'kind'
      ? `Clear cached ${deletion.kind}?`
      : 'Clear the whole cache?'

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <motion.div
      {...fadeItem}
      className="rounded-2xl border border-border bg-surface p-4 shadow-surface"
    >
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </motion.div>
  )
}

function KindPanel({
  kind,
  label,
  view,
  onClear,
}: {
  kind: EgressCacheKind
  label: string
  view: Loaded
  onClear?: () => void
}) {
  const entries = view.entries.filter((entry) => entry.kind === kind)
  const totals = cacheTotals(entries)
  const hosts = hostTotals(entries).slice(0, 6)
  const hostMax = Math.max(1, ...hosts.map((host) => host.bytes))
  const Icon = kindIcon[kind]
  const color = kindColor[kind]
  return (
    <motion.li
      {...fadeItem}
      className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-surface"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-default"
            style={{ color }}
          >
            <Icon className="size-4.5" />
          </span>
          <div className="min-w-0">
            <div className="font-medium">{label}</div>
            <div className="text-xs text-muted">
              Kept {formatTtl(view.ttlSeconds[kind])} after the last use
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xl font-semibold tracking-tight">
            <AnimatedNumber value={totals.bytes} format={formatBytes} />
          </div>
          <div className="text-xs text-muted">
            {plural(totals.count, 'entry', 'entries')} · {plural(totals.hits, 'hit')}
          </div>
        </div>
      </div>
      {hosts.length ? (
        <ul className="flex flex-col gap-2">
          {hosts.map((host) => (
            <li key={host.host} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-mono text-[13px]">{host.host}</span>
                <span className="tabular shrink-0 text-xs text-muted">
                  {formatBytes(host.bytes)} · {host.count}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-default">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(host.bytes / hostMax) * 100}%`, background: color }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nothing cached yet.</p>
      )}
      {onClear && totals.count ? (
        <div className="mt-auto flex justify-end border-t border-separator pt-3">
          <Button variant="ghost" size="sm" onPress={onClear}>
            <Trash2 className="size-3.5" />
            Clear {label.toLowerCase()}
          </Button>
        </div>
      ) : null}
    </motion.li>
  )
}

function EntriesPanel({
  view,
  onDelete,
}: {
  view: Loaded
  onDelete?: (entry: EgressCacheEntry) => void
}) {
  const [kind, setKind] = useState<EgressCacheKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const shown = filterEntries(view.entries, kind, deferred)
  const now = new Date()
  return (
    <Panel
      title="Entries"
      description={
        view.total.count > view.entries.length
          ? `${view.entries.length} most recently used of ${view.total.count}`
          : plural(view.total.count, 'entry', 'entries')
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            aria-label="Kind"
            value={kind}
            onChange={setKind}
            options={[{ id: 'all', label: 'All' }, ...cacheKinds]}
          />
          <SearchInput
            aria-label="Search entries"
            placeholder="Filter by URL"
            value={query}
            onChange={setQuery}
            className="w-56"
          />
        </div>
      }
    >
      {shown.length === 0 ? (
        <EmptyState
          icon={<DatabaseZap />}
          title={view.entries.length ? 'No entries match' : 'The cache is empty'}
          description={
            view.entries.length
              ? undefined
              : 'Downloads land here when jobs install packages or tools through the egress proxy.'
          }
        />
      ) : (
        <>
          <Table label="Cached downloads">
            <thead>
              <tr>
                <Th>Download</Th>
                <Th>Kind</Th>
                <Th align="right">Size</Th>
                <Th align="right">Hits</Th>
                <Th>Last used</Th>
                <Th>Expires</Th>
                {onDelete ? <Th /> : null}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, PAGE_SIZE).map((entry) => (
                <tr key={entry.path}>
                  <Td className="max-w-[28rem]">
                    <div className="truncate font-medium" title={entry.url}>
                      {entryName(entry)}
                    </div>
                    <div className="truncate font-mono text-xs text-muted" title={entry.url}>
                      {entryHost(entry)}
                    </div>
                  </Td>
                  <Td>
                    <Chip>{entry.kind}</Chip>
                  </Td>
                  <Td align="right" className="tabular">
                    {formatBytes(entry.size)}
                  </Td>
                  <Td align="right" className="tabular">
                    {entry.hits}
                  </Td>
                  <Td className="whitespace-nowrap text-muted">
                    <Tooltip content={formatDateTime(entry.lastUsedAt)}>
                      <span tabIndex={0}>{formatRelative(entry.lastUsedAt, now)}</span>
                    </Tooltip>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {entry.expired ? (
                      <Chip tone="warning">expired</Chip>
                    ) : (
                      <Tooltip content={formatDateTime(entry.expiresAt)}>
                        <span tabIndex={0} className="text-muted">
                          {formatRelative(entry.expiresAt, now)}
                        </span>
                      </Tooltip>
                    )}
                  </Td>
                  {onDelete ? (
                    <Td align="right">
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        aria-label={`Remove ${entryName(entry)}`}
                        onPress={() => onDelete(entry)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
          {shown.length > PAGE_SIZE ? (
            <p className="mt-3 text-xs text-muted">
              Showing {PAGE_SIZE} of {shown.length}; narrow the filter to see the rest.
            </p>
          ) : null}
        </>
      )}
    </Panel>
  )
}

function SetupPanel({ view }: { view: Loaded }) {
  return (
    <Panel title="Setup" description="How the replica that answered is configured">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted">Store</dt>
        <dd className="min-w-0 break-all font-mono text-[13px]">
          {view.backend.kind === 's3' ? 'S3' : 'Directory'} · {view.backend.location}
        </dd>
        <dt className="text-muted">Size limit</dt>
        <dd>
          {view.maxBytes === null
            ? 'None, only TTLs remove entries'
            : `${formatBytes(view.maxBytes)}, least recently used go first`}
          {` · downloads over ${formatBytes(view.maxEntryBytes)} pass through`}
        </dd>
        <dt className="text-muted">Counting since</dt>
        <dd>
          {formatDateTime(view.since)}
          {view.syncedAt ? ` · index synced ${formatRelative(view.syncedAt)}` : ''}
        </dd>
        <dt className="text-muted">Cached URLs</dt>
        <dd>
          <ul className="flex flex-col gap-1.5">
            {view.rules.map((rule) => (
              <li
                key={`${rule.kind}:${rule.host}:${rule.paths.join()}`}
                className="flex flex-wrap items-center gap-2"
              >
                <Chip>{rule.kind}</Chip>
                <span className="font-mono text-[13px]">{rule.host}</span>
                {rule.paths.map((path) => (
                  <code key={path} className="rounded bg-default px-1.5 py-0.5 text-xs">
                    {path}
                  </code>
                ))}
                {rule.private ? <Chip tone="warning">private</Chip> : null}
              </li>
            ))}
          </ul>
        </dd>
      </dl>
    </Panel>
  )
}

/** The egress proxy's download cache: what it holds, how it is used, and removing entries. */
export function CachesPage() {
  const { can } = useSession()
  const cache = useEgressCache()
  const remove = useDeleteEgressCache()
  const [deletion, setDeletion] = useState<Deletion | null>(null)
  const writable = can('settings:write')
  const view = cache.data

  return (
    <Page
      title="Caches"
      icon="storage"
      description="Package and tool downloads the egress proxy keeps for jobs"
      actions={
        writable && view && 'backend' in view && view.total.count ? (
          <Button variant="danger-soft" size="sm" onPress={() => setDeletion({ scope: 'all' })}>
            <Trash2 className="size-3.5" />
            Clear all
          </Button>
        ) : undefined
      }
    >
      {cache.isPending ? (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((index) => (
              <Placeholder key={index} className="h-24" />
            ))}
          </div>
          <Placeholder className="h-64" />
        </div>
      ) : cache.isError ? (
        <ErrorState error={cache.error} />
      ) : !view?.configured ? (
        <EmptyState
          icon={<DatabaseZap />}
          title="No egress proxy configured"
          description="Deploy the egress proxy (egressProxy.enabled in the chart) and set server.egress.proxy, so jobs download through it and this page can read its cache."
        />
      ) : 'error' in view ? (
        <Notice tone="danger" title="The egress proxy did not answer">
          {view.error}. Its cache may still work for jobs; check the proxy's logs and that
          HOLTKEEPER_EGRESS_SECRET is the same on both sides.
        </Notice>
      ) : (
        <Overview
          view={view}
          {...(writable
            ? {
                onDelete: (entry: EgressCacheEntry) => setDeletion({ scope: 'entry', entry }),
                onClearKind: (kind: EgressCacheKind) => setDeletion({ scope: 'kind', kind }),
              }
            : {})}
        />
      )}

      <ConfirmDialog
        isOpen={deletion !== null}
        onOpenChange={(open) => !open && setDeletion(null)}
        title={deletion ? deletionTitle(deletion) : 'Clear?'}
        confirmLabel={deletion?.scope === 'entry' ? 'Remove' : 'Clear'}
        isPending={remove.isPending}
        onConfirm={() =>
          deletion &&
          remove.mutate(
            deletion.scope === 'entry'
              ? { paths: [deletion.entry.path] }
              : deletion.scope === 'kind'
                ? { kind: deletion.kind }
                : {},
            {
              onSuccess: (result) => {
                notify.success(
                  'Cache cleared',
                  `Removed ${plural(result.removed, 'entry', 'entries')} · ${formatBytes(result.bytes)}`,
                )
                setDeletion(null)
              },
              onError: (error) => notify.error('Clearing failed', messageOf(error)),
            },
          )
        }
      >
        The next job that needs {deletion?.scope === 'entry' ? 'it' : 'them'} downloads again from
        upstream.
      </ConfirmDialog>
    </Page>
  )
}

function Overview({
  view,
  onDelete,
  onClearKind,
}: {
  view: Loaded
  onDelete?: (entry: EgressCacheEntry) => void
  onClearKind?: (kind: EgressCacheKind) => void
}) {
  const totals = cacheTotals(view.entries)
  const rate = hitRate(view.stats)
  return (
    <>
      <motion.div {...stagger} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Stored"
          value={formatBytes(view.total.bytes)}
          hint={plural(view.total.count, 'entry', 'entries')}
        />
        <Metric
          label="Saved downloads"
          value={formatBytes(totals.savedBytes)}
          hint={`${plural(totals.hits, 'hit')} over the entries' lifetime`}
        />
        <Metric
          label="Hit rate"
          value={rate === undefined ? '—' : `${Math.round(rate)}%`}
          hint={`${view.stats.hits} hits, ${view.stats.misses} misses since ${formatRelative(view.since)}`}
        />
        <Metric
          label="Served from cache"
          value={formatBytes(view.stats.servedBytes)}
          hint={
            view.stats.errors
              ? `${plural(view.stats.errors, 'store error')}, those requests went upstream`
              : `${view.stats.stored} new entries since ${formatRelative(view.since)}`
          }
        />
      </motion.div>

      <Notice tone="warning" title="Cached downloads ignore later access changes">
        Every job behind the proxy gets a cached copy for as long as it stays in the cache, even
        after the package was unpublished or yanked upstream, or the forge or token that allowed the
        download lost access. Clear an entry to take it out of circulation at once.
      </Notice>

      <motion.ul {...stagger} className="grid gap-4 md:grid-cols-2">
        {cacheKinds.map((kind) => (
          <KindPanel
            key={kind.id}
            kind={kind.id}
            label={kind.label}
            view={view}
            {...(onClearKind ? { onClear: () => onClearKind(kind.id) } : {})}
          />
        ))}
      </motion.ul>

      <EntriesPanel view={view} {...(onDelete ? { onDelete } : {})} />
      <SetupPanel view={view} />
    </>
  )
}
