import type { ApiChange, DependencyDetail, PublicApiPackageDetail } from '@holtkeeper/api'
import { useState } from 'react'

import { useDependencyUpgrade, usePublicApiDiff } from '../../api/queries.ts'
import { upgradeVersions } from '../../lib/dependencies.ts'
import { versionKey, versionLabel } from '../../lib/public-api.ts'
import { repoKey } from '../../lib/repo.ts'
import { importPath } from '../../lib/usages.ts'
import {
  EmptyState,
  ErrorState,
  Markdown,
  Notice,
  Panel,
  Placeholder,
  Segmented,
  Select,
  Tag,
} from '../../ui/index.ts'
import { BackfillReleasesButton } from '../analyses/BackfillReleases.tsx'
import { Signature } from './ApiTab.tsx'

const changeTone = {
  removed: 'danger',
  changed: 'warning',
  deprecated: 'warning',
  added: 'success',
} as const

function ChangeRow({ change, pkg }: { change: ApiChange; pkg: string }) {
  return (
    <div className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={changeTone[change.change]}>{change.change}</Tag>
        <span className="mono font-medium">{change.name}</span>
        <Tag>{change.kind}</Tag>
        <span className="mono text-xs text-muted">{importPath(pkg, change.subpath)}</span>
      </div>
      {change.change === 'changed' && change.before && change.after ? (
        <div className="grid gap-2 lg:grid-cols-2">
          <div>
            <div className="mb-1 text-xs text-muted">Before</div>
            <Signature code={change.before} />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">After</div>
            <Signature code={change.after} />
          </div>
        </div>
      ) : change.after || change.before ? (
        <Signature code={change.after ?? change.before ?? ''} />
      ) : null}
    </div>
  )
}

/** What changed in an internal package's public API between an earlier recorded release and the shown one. */
export function ChangesTab({ data }: { data: PublicApiPackageDetail }) {
  const current = data.versions.find((v) => v.analysisId === data.analysisId)
  const older = data.versions.filter(
    (v) => !v.head && v.analysisId !== data.analysisId && v.analyzedAt <= data.analyzedAt,
  )
  const [from, setFrom] = useState<string | undefined>(undefined)
  const fromKey = from ?? (older[0] ? versionKey(older[0]) : undefined)
  const diff = usePublicApiDiff(
    {
      name: data.package.name,
      to: current ? versionKey(current) : 'latest',
      repo: repoKey(data.repo),
      ...(fromKey ? { from: fromKey } : {}),
    },
    fromKey !== undefined,
  )
  const [kind, setKind] = useState<'all' | ApiChange['change']>('all')

  if (!fromKey)
    return (
      <EmptyState
        title="No earlier version on record"
        description="Analyse past releases with the public API snapshot to compare versions."
        action={<BackfillReleasesButton analyzer="api-surface" repo={data.repo} />}
      />
    )
  const result = diff.data
  const changes =
    result?.diff.changes.filter((change) => kind === 'all' || change.change === kind) ?? []
  return (
    <Panel
      title={
        result
          ? `${result.from.version} → ${current ? versionLabel(current) : result.to.version}`
          : 'Changes'
      }
      description={
        result
          ? `${result.diff.removed} removed, ${result.diff.changed} changed, ${result.diff.deprecated} deprecated, ${result.diff.added} added; calls for a ${result.diff.required} release${result.diff.bumped ? `, the version got a ${result.diff.bumped} bump` : ''}.`
          : undefined
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Compare with"
            className="w-48"
            value={fromKey}
            onChange={setFrom}
            options={older.map((v) => ({
              id: versionKey(v),
              label: `from ${versionLabel(v)}`,
              text: versionLabel(v),
            }))}
          />
          <Segmented
            aria-label="Change kind"
            value={kind}
            onChange={setKind}
            options={[
              { id: 'all', label: 'All' },
              { id: 'removed', label: 'Removed' },
              { id: 'changed', label: 'Changed' },
              { id: 'added', label: 'Added' },
            ]}
          />
        </div>
      }
    >
      {diff.isPending ? (
        <Placeholder className="h-48" />
      ) : diff.isError ? (
        <ErrorState error={diff.error} />
      ) : result ? (
        <div className="flex flex-col gap-3">
          {result.diff.semverWarning ? (
            <Notice tone="danger" title="Semver">
              {result.diff.semverWarning}.
            </Notice>
          ) : null}
          {changes.length ? (
            <div>
              {changes.map((change) => (
                <ChangeRow
                  key={`${change.change} ${change.subpath} ${change.name}`}
                  change={change}
                  pkg={data.package.name}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title="No changes"
              description="No export of this kind changed between these versions."
            />
          )}
        </div>
      ) : null}
    </Panel>
  )
}

/**
 * A third-party library's release notes and API changes from the oldest version in use to the
 * latest, read from the library index on demand.
 */
export function ReleaseNotes({ detail }: { detail: DependencyDetail }) {
  const options = upgradeVersions(detail)
  const from = options.from[0]
  const to = detail.latest ?? options.to[0]
  const upgrade = useDependencyUpgrade(
    {
      ecosystem: detail.ecosystem,
      name: detail.name,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
    from !== undefined && to !== undefined && from !== to,
  )
  if (!from || !to || from === to)
    return (
      <EmptyState
        title="Nothing newer"
        description="Every repository is on the newest version the library index knows."
      />
    )
  if (upgrade.isPending) return <Placeholder className="h-48" />
  if (upgrade.isError) return <ErrorState error={upgrade.error} />
  const data = upgrade.data
  return (
    <Panel title={`${data.from ?? from} → ${data.to ?? to}`}>
      <div className="flex flex-col gap-4">
        {data.api?.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {data.api.map((change) => (
              <li
                key={`${change.change} ${change.subpath} ${change.name}`}
                className="flex items-center gap-2"
              >
                <Tag tone={changeTone[change.change]}>{change.change}</Tag>
                <span className="mono">{change.name}</span>
                {change.subpath !== '.' ? (
                  <span className="mono text-xs text-muted">{change.subpath}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {data.changes ? (
          <Markdown text={data.changes} />
        ) : (
          <p className="text-sm text-muted">No release notes are indexed for these versions.</p>
        )}
      </div>
    </Panel>
  )
}
