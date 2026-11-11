import { type RepoAssetsView, type RepoRef, formatBytes } from '@holtkeeper/api'
import { Images } from 'lucide-react'
import { useState } from 'react'

import { useRepoAssets } from '../../api/queries.ts'
import {
  canOptimize,
  filterRows,
  kindColor,
  policyLines,
  policySource,
  severityTone,
} from '../../lib/assets.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import { pageSettingKeys } from '../../lib/settings-tabs.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  LinkButton,
  Placeholder,
  Segmented,
  Table,
  Tag,
  Td,
  Th,
} from '../../ui/index.ts'
import { MiniSparkline } from '../../ui/MiniSparkline.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { PolicyBlock } from '../knowledge/PolicyBlock.tsx'
import { MediaDialog } from '../media/MediaDialog.tsx'
import { SettingsButton } from '../settings/SettingsSheet.tsx'
import { useSession } from '../shell/session.ts'

type Summary = NonNullable<RepoAssetsView['summary']>

function KindBar({ totals, total }: { totals: Summary['totals']; total: number }) {
  if (!total) return null
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="img"
        aria-label={totals.map((t) => `${t.kind} ${formatBytes(t.bytes)}`).join(', ')}
        className="flex h-1.5 w-full gap-0.5"
      >
        {totals.map((t) => (
          <span
            key={t.kind}
            className="h-full min-w-0.5 rounded-sm"
            style={{ flexGrow: t.bytes, flexBasis: 0, background: kindColor(t.kind) }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        {totals.map((t) => (
          <li key={t.kind} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-sm"
              style={{ background: kindColor(t.kind) }}
            />
            {t.kind} <span className="mono">{formatBytes(t.bytes)}</span>
            <span className="text-dim">({t.count})</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SummaryCard({ view, summary }: { view: RepoAssetsView; summary: Summary }) {
  const trend = view.trend.map((point) => point.totalBytes)
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="mono text-[22px] font-semibold tracking-tight">
          {formatBytes(summary.totalBytes)}
        </span>
        <span className="text-sm text-muted">{plural(summary.files, 'file')}</span>
        {view.checkedPolicy ? (
          <span className="flex items-center gap-1.5">
            <Tag tone={summary.errors ? 'danger' : 'success'} dot>
              {plural(summary.errors, 'error')}
            </Tag>
            <Tag tone={summary.warnings ? 'warning' : 'default'} dot>
              {plural(summary.warnings, 'warning')}
            </Tag>
          </span>
        ) : (
          <Tag tone="info">checked before the policy existed</Tag>
        )}
        {summary.savings ? (
          <span className="text-sm text-muted">
            saves <span className="mono">{formatBytes(summary.savings)}</span>
          </span>
        ) : null}
        {summary.duplicateBytes ? (
          <span className="text-sm text-muted">
            duplicates <span className="mono">{formatBytes(summary.duplicateBytes)}</span>
          </span>
        ) : null}
        {view.createdAt ? (
          <span className="ml-auto text-xs text-dim">
            checked {formatRelative(view.createdAt)}
            {view.sha ? <span className="mono"> · {view.sha.slice(0, 8)}</span> : null}
          </span>
        ) : null}
      </div>
      <KindBar totals={summary.totals} total={summary.totalBytes} />
      {trend.length > 1 ? (
        <MiniSparkline
          values={trend}
          color="var(--info)"
          label="Total asset bytes of recent analyses"
          className="h-8 w-full"
        />
      ) : null}
      {summary.budgets.length ? (
        <ul className="flex flex-col gap-1">
          {summary.budgets.map((budget) => (
            <li key={budget.id} className="flex items-center gap-2 text-sm">
              <Tag tone="danger">budget</Tag>
              {budget.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function FilesTable({
  summary,
  onOptimize,
}: {
  summary: Summary
  onOptimize?: (file: string) => void
}) {
  const [filter, setFilter] = useState<'issues' | 'all'>('issues')
  const rows = filterRows(summary.rows, filter)
  return (
    <section className="rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 pt-3">
        <h2 className="text-sm font-semibold">Files</h2>
        <Segmented
          aria-label="Files shown"
          value={filter}
          onChange={setFilter}
          options={[
            { id: 'issues', label: 'Breaking the policy' },
            { id: 'all', label: 'Everything to improve' },
          ]}
        />
      </div>
      {rows.length ? (
        <Table
          label="Asset files"
          {...(summary.more ? { footer: `${summary.more} more files not listed` } : {})}
        >
          <thead>
            <tr>
              <Th>File</Th>
              <Th align="right">Size</Th>
              <Th>Problems</Th>
              <Th>Suggestion</Th>
              {onOptimize ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.path}>
                <Td>
                  <span className="mono text-xs">{row.path}</span>
                  <span className="ml-2 text-xs text-dim">
                    {row.kind} · {row.format}
                    {row.width && row.height ? ` · ${row.width}×${row.height}` : ''}
                  </span>
                </Td>
                <Td align="right" className="mono text-xs">
                  {formatBytes(row.bytes)}
                </Td>
                <Td>
                  <ul className="flex flex-col gap-1">
                    {row.problems.map((problem, index) => (
                      <li key={index} className="flex items-start gap-1.5 text-xs">
                        <Tag tone={severityTone(problem.severity)}>{problem.rule}</Tag>
                        <span className="text-muted">{problem.message}</span>
                      </li>
                    ))}
                  </ul>
                </Td>
                <Td className="text-xs">
                  {row.suggestion ? (
                    <span title={row.suggestion.how}>
                      {row.suggestion.format}{' '}
                      <span className="mono">{formatBytes(row.suggestion.expectedBytes)}</span>
                      <span className="text-muted">
                        {' '}
                        saves {formatBytes(row.suggestion.saving)}
                        {row.suggestion.method === 'estimate' ? ' (estimate)' : ''}
                      </span>
                    </span>
                  ) : (
                    <span className="text-dim">—</span>
                  )}
                </Td>
                {onOptimize ? (
                  <Td align="right">
                    {canOptimize(row) ? (
                      <Button size="sm" variant="ghost" onPress={() => onOptimize(row.path)}>
                        Optimize
                      </Button>
                    ) : null}
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="px-3.5 py-3 text-sm text-muted">
          {filter === 'issues'
            ? 'Every file follows the asset policy.'
            : 'Nothing to improve: no violations, duplicates or savings.'}
        </p>
      )}
    </section>
  )
}

function PolicyCard({ view, repo }: { view: RepoAssetsView; repo: RepoRef }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Asset policy</h2>
        <span className="flex items-center gap-2 text-xs text-muted">
          {policySource(view.policySource)}
          <SettingsButton
            title="Assets analyzer settings"
            keys={pageSettingKeys.assets}
            label="Analyzer options"
          />
        </span>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {policyLines(view.policy).map((line) => (
          <div key={line.label} className="contents">
            <dt className="text-muted">{line.label}</dt>
            <dd className="mono text-xs leading-5">{line.value}</dd>
          </div>
        ))}
      </dl>
      <PolicyBlock settingKey="assets.policy" space={{ kind: 'repo', repo }} members={[]} />
      <p className="text-xs text-dim">
        Prose rules for agents and reviews go in the Guide's Assets section.{' '}
        <LinkButton
          to="/knowledge"
          search={{ space: `repo:${repo.forge}:${repo.path}`, tab: 'guide' }}
          variant="ghost"
          size="sm"
        >
          Open Guide
        </LinkButton>
      </p>
    </section>
  )
}

/**
 * The Assets tab of a repository: summary with bytes by kind and trend, files breaking the asset
 * policy or worth optimizing, and the policy with its inheritance and editor. `file` (with `ref`)
 * opens the media dialog on that file, as review comments link to it. Reads stored records only.
 */
export function AssetsTab({ repo, file, ref }: { repo: RepoRef; file?: string; ref?: string }) {
  const { can } = useSession()
  const assets = useRepoAssets(repo)
  const [media, setMedia] = useState<{ file: string; ref?: string } | undefined>(
    file && can('analyses:run') ? { file, ...(ref ? { ref } : {}) } : undefined,
  )
  if (assets.isPending) return <Placeholder className="h-64" />
  if (assets.isError) return <ErrorState error={assets.error} />
  const view = assets.data
  return (
    <div className="flex flex-col gap-4">
      {view.summary ? (
        <>
          <SummaryCard view={view} summary={view.summary} />
          <FilesTable
            summary={view.summary}
            {...(can('analyses:run')
              ? { onOptimize: (path: string) => setMedia({ file: path }) }
              : {})}
          />
        </>
      ) : (
        <EmptyState
          icon={<Images />}
          title="No assets analysis yet"
          description="Run the assets analyzer to check images, fonts and media against the policy."
          action={<RunJobButton repo={repo} analyzer="assets" label="Run assets" />}
        />
      )}
      <PolicyCard view={view} repo={repo} />
      {media ? (
        <MediaDialog
          repo={repo}
          isOpen
          onOpenChange={(open) => !open && setMedia(undefined)}
          initial={media}
        />
      ) : null}
    </div>
  )
}
