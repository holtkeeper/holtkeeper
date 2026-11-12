import type { ApiSymbol, DependencyApi, PublicApiPackageDetail } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Library, Search } from 'lucide-react'
import { useState } from 'react'

import { formatDate, formatDateTime, formatRef, plural } from '../../lib/format.ts'
import { documentedShare, groupSymbols, versionKey, versionLabel } from '../../lib/public-api.ts'
import { repoKey, repoSplat } from '../../lib/repo.ts'
import { importPath } from '../../lib/usages.ts'
import {
  EmptyState,
  KeyValue,
  LoadMore,
  Markdown,
  Notice,
  Panel,
  SearchInput,
  Select,
  Tag,
} from '../../ui/index.ts'

const symbolPage = 150

/** A share of documented exports as a short bar and a percentage. */
function DocumentedBar({ documented, exports }: { documented: number; exports: number }) {
  const share = documentedShare(documented, exports)
  if (share === undefined) return <span className="text-muted">—</span>
  const color = share >= 80 ? 'var(--ok)' : share >= 40 ? 'var(--warn)' : 'var(--bad)'
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-raise">
        <span
          className="block h-full rounded-full"
          style={{ width: `${share}%`, background: color }}
        />
      </span>
      <span className="tabular w-9 text-right">{share}%</span>
    </span>
  )
}

/** A declaration in a code block. */
export function Signature({ code }: { code: string }) {
  return (
    <pre className="mono overflow-x-auto rounded-lg border border-line bg-sunk px-3 py-2 text-[12px] leading-relaxed">
      {code}
    </pre>
  )
}

function SymbolCard({ symbol, importFrom }: { symbol: ApiSymbol; importFrom: string }) {
  return (
    <div
      id={`symbol-${symbol.name}`}
      className="flex flex-col gap-2 border-b border-line py-4 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono font-semibold">{symbol.name}</span>
        <Tag>{symbol.kind}</Tag>
        {symbol.deprecated !== undefined ? <Tag tone="warning">deprecated</Tag> : null}
        <span className="mono ml-auto text-xs text-muted">
          {symbol.file}:{symbol.line}
        </span>
      </div>
      {symbol.deprecated ? (
        <div className="text-sm text-warn">Deprecated: {symbol.deprecated}</div>
      ) : null}
      {symbol.doc ? <Markdown className="text-sm" text={symbol.doc} /> : null}
      <Signature code={symbol.signature} />
      {symbol.kind !== 'reexport' ? (
        <div className="mono text-xs text-muted">
          import {symbol.name === 'default' ? 'value' : `{ ${symbol.name} }`} from '{importFrom}'
        </div>
      ) : null}
    </div>
  )
}

/** Where an internal package's shown version comes from: ref, repository, totals and other homes. */
function PackageFacts({ data }: { data: PublicApiPackageDetail }) {
  const symbols = data.package.entries.flatMap((entry) =>
    entry.symbols.filter((symbol) => symbol.kind !== 'reexport'),
  )
  const documented = symbols.filter((symbol) => symbol.doc).length
  return (
    <KeyValue
      rows={[
        {
          label: 'Version',
          value: (
            <span>
              <span className="mono">{data.package.version ?? 'no version'}</span>
              {data.ref ? (
                <span className="mono ml-1 text-xs text-muted" title={data.ref}>
                  ({formatRef(data.ref)})
                </span>
              ) : (
                <span className="text-muted"> · default branch</span>
              )}
            </span>
          ),
        },
        {
          label: 'Source',
          value: (
            <span className="mono">
              <Link
                to="/repos/$"
                params={{ _splat: repoSplat(data.repo) }}
                className="hover:underline"
              >
                {repoKey(data.repo)}
              </Link>
              {data.package.dir !== '.' ? (
                <span className="text-muted">/{data.package.dir}</span>
              ) : null}
            </span>
          ),
        },
        {
          label: 'Exports',
          value: (
            <span className="inline-flex items-center gap-3">
              {plural(symbols.length, 'export')}
              <DocumentedBar documented={documented} exports={symbols.length} />
            </span>
          ),
        },
        { label: 'Analysed', value: formatDateTime(data.analyzedAt) },
        {
          label: 'Also in',
          value: data.alsoIn.length ? (
            <span className="flex flex-wrap gap-1.5">
              {data.alsoIn.map((other) => (
                <Link
                  key={repoKey(other)}
                  to="/repos/$"
                  params={{ _splat: repoSplat(other) }}
                  className="mono text-xs hover:underline"
                >
                  {repoKey(other)}
                </Link>
              ))}
            </span>
          ) : null,
        },
      ]}
    />
  )
}

/** The exports of one entry point of an internal package, grouped by kind and filterable. */
export function ApiTab({
  data,
  onVersion,
}: {
  data: PublicApiPackageDetail
  onVersion: (version: string) => void
}) {
  const entries = data.package.entries
  const [subpath, setSubpath] = useState(entries[0]?.subpath ?? '.')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(symbolPage)
  const current = data.versions.find((v) => v.analysisId === data.analysisId) ?? data.versions[0]
  const entry = entries.find((item) => item.subpath === subpath) ?? entries[0]
  const importFrom = entry ? importPath(data.package.name, entry.subpath) : data.package.name
  const groups = entry ? groupSymbols(entry.symbols, query) : []
  let shown = 0
  return (
    <div className="flex flex-col gap-4">
      {data.removed ? (
        <Notice tone="danger" title="Removed from the repository">
          {repoKey(data.repo)} has not had this package on its default branch since{' '}
          {formatDate(data.removed.at)}; avoid it in new code.
          {data.removed.renamedTo ? ` Probably renamed to ${data.removed.renamedTo}.` : ''}
          {data.removed.movedTo
            ? ` Still in ${data.removed.movedTo.map((other) => repoKey(other)).join(', ')}.`
            : ''}
        </Notice>
      ) : null}
      <PackageFacts data={data} />
      {entry ? (
        <Panel
          title={<span className="mono">{importFrom}</span>}
          description={`${plural(entry.symbols.length, 'export')}${entry.file ? ` from ${entry.file}` : ''}${entry.truncated ? `, ${entry.truncated} more not recorded` : ''}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {current && data.versions.length > 1 ? (
                <Select
                  aria-label="Version"
                  className="w-48"
                  value={versionKey(current)}
                  onChange={onVersion}
                  options={data.versions.map((v) => ({
                    id: versionKey(v),
                    label: versionLabel(v),
                    text: versionLabel(v),
                  }))}
                />
              ) : null}
              {entries.length > 1 ? (
                <Select
                  aria-label="Entry point"
                  className="w-48"
                  value={entry.subpath}
                  onChange={(value) => {
                    setSubpath(value)
                    setLimit(symbolPage)
                  }}
                  options={entries.map((item) => ({
                    id: item.subpath,
                    label: `${item.subpath} (${item.symbols.length})`,
                    text: item.subpath,
                  }))}
                />
              ) : null}
              <SearchInput
                aria-label="Filter exports"
                placeholder="Name or doc text"
                value={query}
                onChange={setQuery}
                className="w-56"
              />
            </div>
          }
        >
          {groups.length ? (
            <div className="flex flex-col gap-6">
              <div className="flex flex-wrap gap-3">
                {groups.map((group) => (
                  <a
                    key={group.kind}
                    href={`#kind-${group.kind}`}
                    className="text-sm text-muted hover:text-foreground"
                  >
                    {group.label} <span className="tabular">{group.symbols.length}</span>
                  </a>
                ))}
              </div>
              {groups.map((group) => {
                const visible = group.symbols.slice(0, Math.max(0, limit - shown))
                shown += visible.length
                if (!visible.length) return null
                return (
                  <section key={group.kind} id={`kind-${group.kind}`}>
                    <h2 className="mb-1 text-[11.5px] font-medium text-muted">{group.label}</h2>
                    {visible.map((symbol) => (
                      <SymbolCard key={symbol.name} symbol={symbol} importFrom={importFrom} />
                    ))}
                  </section>
                )
              })}
              {groups.reduce((sum, group) => sum + group.symbols.length, 0) > limit ? (
                <LoadMore onLoad={() => setLimit(limit + symbolPage)}>Show more</LoadMore>
              ) : null}
            </div>
          ) : (
            <EmptyState
              icon={<Search />}
              title="Nothing matches"
              description="Try another part of the name."
            />
          )}
        </Panel>
      ) : (
        <EmptyState title="No entry point" />
      )}
    </div>
  )
}

/**
 * What is known about a third-party library's API: the version the totals describe, exports,
 * the documented share and the entry points.
 */
export function ApiSummary({ api }: { api: DependencyApi }) {
  if (!api.api)
    return (
      <EmptyState
        icon={<Library />}
        title="No API on record"
        description="The library index records the API of the versions in use once library indexing is on."
      />
    )
  return (
    <KeyValue
      rows={[
        {
          label: 'Version',
          value: api.version ? <span className="mono">{api.version}</span> : null,
        },
        { label: 'Exports', value: plural(api.api.exports, 'export') },
        {
          label: 'Documented',
          value: <DocumentedBar documented={api.api.documented} exports={api.api.exports} />,
        },
        {
          label: 'Entry points',
          value: api.subpaths.length ? (
            <span className="flex flex-wrap gap-1.5">
              {api.subpaths.map((subpath) => (
                <Tag key={subpath} mono>
                  {importPath(api.name, subpath)}
                </Tag>
              ))}
            </span>
          ) : null,
        },
      ]}
    />
  )
}
