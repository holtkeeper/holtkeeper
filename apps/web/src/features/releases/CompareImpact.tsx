import type {
  ReleaseCompareApiPackage,
  ReleaseCompareCheck,
  RepoRef,
  UpgradeCheckData,
  UpgradeFinding,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Camera, RotateCw, ShieldAlert } from 'lucide-react'

import { messageOf } from '../../api/client.ts'
import {
  useJobMutations,
  useReleaseCompareApi,
  useReleaseCompareCheck,
  useReleaseComparePackage,
  useStartReleaseCompareCheck,
} from '../../api/queries.ts'
import { bumpTones } from '../../lib/releases.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  ErrorState,
  Markdown,
  Notice,
  Panel,
  Placeholder,
  Tag,
  notify,
} from '../../ui/index.ts'
import { BackfillReleasesButton } from '../analyses/BackfillReleases.tsx'
import {
  apiBreaks,
  apiCounts,
  checkAction,
  checkActive,
  fileLocation,
  findingGroups,
  missingText,
  type PackageQuery,
  severityTags,
  skippedLines,
  underBumped,
  verdictTags,
} from './compare-impact.ts'
import type { CompareRange } from './compare-range.ts'

function ApiPackage({ pkg }: { pkg: ReleaseCompareApiPackage }) {
  const diff = pkg.diff
  return (
    <details className="rounded-md border border-line px-3 py-2 text-sm">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
        <span className="mono font-medium">{pkg.name}</span>
        <span className="mono text-xs text-muted">
          {pkg.from ?? 'new'}
          <span className="text-dim"> → </span>
          {pkg.to ?? 'removed'}
        </span>
        {diff ? (
          <>
            {apiBreaks(diff) ? <Tag tone="danger">breaking</Tag> : null}
            <Tag tone={bumpTones[diff.required]} title="What the API changes call for">
              needs {diff.required}
            </Tag>
            {diff.bumped ? (
              <Tag
                tone={underBumped(diff) ? 'danger' : 'default'}
                title="What the version numbers did"
              >
                bumped {diff.bumped}
              </Tag>
            ) : null}
            <span className="text-xs text-muted">{apiCounts(diff)}</span>
          </>
        ) : null}
        {pkg.impact && pkg.impact.repos > 0 ? (
          <span className="text-xs text-muted">
            {pkg.impact.repos} {pkg.impact.repos === 1 ? 'repository' : 'repositories'} affected
            {pkg.impact.breaking ? ` · ${pkg.impact.breaking} breaking uses` : ''}
            {pkg.impact.check ? ` · ${pkg.impact.check} to check` : ''}
          </span>
        ) : null}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {diff?.semverWarning ? (
          <Notice tone="danger" title="Semver">
            {diff.semverWarning}.
          </Notice>
        ) : null}
        <Markdown text={pkg.markdown} />
        {pkg.impact?.markdown ? (
          <section className="flex flex-col gap-1">
            <h4 className="text-xs text-dim">Uses in other repositories</h4>
            <Markdown text={pkg.impact.markdown} />
          </section>
        ) : null}
      </div>
    </details>
  )
}

function SnapshotRefsButton({ repo, refs }: { repo: RepoRef; refs: readonly string[] }) {
  const { create } = useJobMutations()
  const queue = async () => {
    try {
      await Promise.all(
        refs.map((ref) =>
          create.mutateAsync({ analyzer: 'api-surface', repo: repoKey(repo), ref }),
        ),
      )
      notify.success(
        'Snapshots queued',
        `The public API at ${refs.join(' and ')} is read in Ops › Runs; reload this page once they finish.`,
      )
    } catch (error) {
      notify.error('Not queued', messageOf(error))
    }
  }
  return (
    <Button size="sm" variant="tertiary" isPending={create.isPending} onPress={() => void queue()}>
      <Camera className="size-3.5" />
      Snapshot {refs.join(' and ')}
    </Button>
  )
}

/**
 * Releases › Compare's Public API section: the repository's own packages whose exports differ
 * between the two ends, in the server's order (breaking ones first), each folding out the API
 * diff and the uses in other repositories it touches. When an end has no snapshot nothing was
 * compared: a note says which, with a button that snapshots exactly the missing tags when the
 * server allows it, else the past-releases backfill.
 */
export function PublicApiSection({ repo, range }: { repo: RepoRef; range: CompareRange }) {
  const api = useReleaseCompareApi(repo, range)
  const refs = api.data?.backfill?.refs ?? []
  const backfill =
    api.data?.backfill?.allowed === true ? (
      refs.length ? (
        <SnapshotRefsButton repo={repo} refs={refs} />
      ) : (
        <BackfillReleasesButton analyzer="api-surface" repo={repo} variant="tertiary" />
      )
    ) : null
  const packages = api.data?.packages ?? []
  const missing = api.data ? missingText(api.data.missing) : ''
  const compared = !packages.length && !missing
  return (
    <Panel
      variant="flush"
      title={packages.length ? `Public API · ${packages.length}` : 'Public API'}
      description="Exports of this repository's own packages that differ between the two ends."
    >
      {api.isPending ? (
        <Placeholder className="h-16" />
      ) : api.isError ? (
        <ErrorState error={api.error} />
      ) : !api.data.recorded ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted">
            No public API snapshot is recorded for this repository yet.
          </p>
          {backfill}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {packages.map((pkg) => (
            <ApiPackage key={pkg.name} pkg={pkg} />
          ))}
          {compared ? <p className="text-sm text-muted">No public API changed.</p> : null}
          {missing ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className={packages.length ? 'text-xs text-muted' : 'text-sm text-muted'}>
                {packages.length ? 'No snapshot for' : 'Cannot compare: no snapshot for'} {missing}.
              </p>
              {backfill}
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  )
}

/**
 * What changed in one dependency between its two versions and the uses it breaks, loaded once the
 * row is expanded.
 */
export function PackageChanges({ repo, query }: { repo: RepoRef; query: PackageQuery }) {
  const answer = useReleaseComparePackage(repo, query, true)
  if (answer.isPending) return <Placeholder className="h-20" />
  if (answer.isError) return <ErrorState error={answer.error} />
  return answer.data.found ? (
    <Markdown text={answer.data.markdown} />
  ) : (
    <p className="text-sm text-muted">{answer.data.markdown}</p>
  )
}

function FindingView({ finding }: { finding: UpgradeFinding }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-line px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{finding.title}</span>
        <Tag>{finding.category}</Tag>
      </div>
      <Markdown text={finding.detail} />
      {finding.affects ? (
        <p className="text-xs text-muted">
          <span className="text-dim">Affects: </span>
          {finding.affects}
        </p>
      ) : null}
      {finding.files.length ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {finding.files.map((file) => (
            <li key={fileLocation(file)} className="mono text-xs text-muted">
              {fileLocation(file)}
            </li>
          ))}
        </ul>
      ) : null}
      {finding.check ? (
        <div className="text-sm">
          <span className="text-xs text-dim">How to check</span>
          <Markdown text={finding.check} />
        </div>
      ) : null}
    </li>
  )
}

function CheckResult({ data, analysisId }: { data: UpgradeCheckData; analysisId?: string }) {
  const verdict = verdictTags[data.verdict]
  const skipped = skippedLines(data.skipped)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Tag tone={verdict.tone} dot>
          {verdict.label}
        </Tag>
        <span className="mono text-xs text-muted">
          {data.from.label ?? data.from.ref}
          <span className="text-dim"> → </span>
          {data.to.label ?? data.to.ref}
        </span>
        {analysisId ? (
          <Link
            to="/analyses/$id"
            params={{ id: analysisId }}
            search={{}}
            className="text-xs text-muted hover:underline"
          >
            Open the analysis
          </Link>
        ) : null}
      </div>
      <Markdown text={data.summary} />
      {findingGroups(data.findings).map((group) => (
        <section key={group.severity} className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-xs text-dim">
            <Tag tone={severityTags[group.severity].tone}>{severityTags[group.severity].label}</Tag>
            <span className="tabular">{group.findings.length}</span>
          </h3>
          <ul className="flex flex-col gap-2 text-sm">
            {group.findings.map((finding) => (
              <FindingView key={finding.id} finding={finding} />
            ))}
          </ul>
        </section>
      ))}
      {data.areas.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted">
            Checked in {data.areas.length} {data.areas.length === 1 ? 'area' : 'areas'}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {data.areas.map((area) => (
              <li key={area.name}>
                <span className="mono">{area.name}</span>
                <span className="text-xs text-muted"> · {area.files} files · </span>
                <span className="text-muted">{area.summary}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {skipped.length || data.capped ? (
        <p className="text-xs text-muted">
          Not checked:{' '}
          {[...skipped, ...(data.capped ? ['size limits left part out'] : [])].join('; ')}.
        </p>
      ) : null}
    </div>
  )
}

function CheckProgress({ check }: { check: ReleaseCompareCheck }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        {check.status === 'queued'
          ? 'Waiting for a worker…'
          : 'Agents are reading the changes area by area…'}
        {check.jobId ? (
          <>
            {' '}
            <Link
              to="/ops/runs/$jobId"
              params={{ jobId: check.jobId }}
              className="text-xs hover:underline"
            >
              Open the run
            </Link>
          </>
        ) : null}
      </p>
      <Placeholder className="h-16" />
    </div>
  )
}

/**
 * Releases › Compare's breaking-change check: where the AI check of the range stands (polled
 * while it runs), its verdict, summary and findings by severity once done, and the button that
 * starts it or runs it again. `canRun` (the caller may run AI work on the repository) gates the
 * button; a finished result shows to every reader.
 */
export function BreakingCheckCard({
  repo,
  range,
  canRun,
}: {
  repo: RepoRef
  range: CompareRange
  canRun: boolean
}) {
  const check = useReleaseCompareCheck(repo, range)
  const start = useStartReleaseCompareCheck()
  const action = checkAction(check.data)
  if (!canRun && (check.data?.status ?? 'none') === 'none') return null
  const run = () =>
    start.mutate({
      repo: repoKey(repo),
      ...(range.from !== undefined ? { from: range.from } : {}),
      ...(range.to !== undefined ? { to: range.to } : {}),
      ...(action === 'again' ? { force: true } : {}),
    })
  return (
    <Panel
      variant="flush"
      title="Breaking-change check"
      description="Several AI agents read the code changes area by area, with the public API and dependency changes, and list what could break an installation that upgrades. Each run spends AI budget."
      actions={
        canRun && action ? (
          <Button size="sm" isPending={start.isPending} onPress={run}>
            {action === 'again' ? (
              <RotateCw className="size-3.5" />
            ) : (
              <ShieldAlert className="size-3.5" />
            )}
            {action === 'again' ? 'Run again' : 'Check what could break'}
          </Button>
        ) : null
      }
    >
      {start.isError ? (
        <Notice tone="danger" title="Not started">
          {messageOf(start.error)}
        </Notice>
      ) : null}
      {check.isPending ? (
        <Placeholder className="h-16" />
      ) : check.isError ? (
        <ErrorState error={check.error} />
      ) : checkActive(check.data) ? (
        <CheckProgress check={check.data} />
      ) : (
        <div className="flex flex-col gap-3">
          {check.data.status === 'failed' ? (
            <Notice tone="danger" title="The last check failed">
              {check.data.error ?? 'No reason given.'}
              {check.data.data ? ' The result below is from an earlier run.' : ''}
            </Notice>
          ) : null}
          {check.data.data ? (
            <CheckResult
              data={check.data.data}
              {...(check.data.analysisId ? { analysisId: check.data.analysisId } : {})}
            />
          ) : check.data.status === 'none' ? (
            <p className="text-sm text-muted">Not checked yet.</p>
          ) : null}
        </div>
      )}
    </Panel>
  )
}
