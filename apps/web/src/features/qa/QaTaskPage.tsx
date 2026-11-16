import type {
  QaChangeView,
  QaSummarySections,
  QaSummaryView,
  QaTaskView,
  TestIdFileChange,
} from '@holtkeeper/api'
import { useParams } from '@tanstack/react-router'
import { ExternalLink, FileCode2, RefreshCw, Sparkles } from 'lucide-react'

import { ApiError, messageOf } from '../../api/client.ts'
import { useQaTask, useSummarizeQaTask } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import {
  changeKinds,
  changeLabel,
  changesByRepo,
  stalenessText,
  testIdSummary,
  unreviewed,
} from '../../lib/qa.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  Notice,
  Page,
  Panel,
  Placeholder,
  Tag,
  notify,
} from '../../ui/index.ts'

const verdicts: Record<
  QaSummarySections['verdict'],
  { label: string; tone: 'danger' | 'warning' | 'default' }
> = {
  must: { label: 'Test it', tone: 'danger' },
  should: { label: 'Worth testing', tone: 'warning' },
  optional: { label: 'Testing optional', tone: 'default' },
}

const priorities = { high: 'danger', medium: 'warning', low: 'default' } as const

function List({ items }: { items: readonly string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
      {items.map((item, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- texts may repeat
        <li key={index}>{item}</li>
      ))}
    </ul>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  )
}

function SummaryBody({ sections }: { sections: QaSummarySections }) {
  const verdict = verdicts[sections.verdict]
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={verdict.tone} dot>
            {verdict.label}
          </Tag>
          <span className="text-xs text-muted">{sections.verdictReason}</span>
        </div>
        <p className="text-sm">{sections.overview}</p>
      </div>
      {sections.changes.length ? (
        <Section title="What changed">
          <List items={sections.changes} />
        </Section>
      ) : null}
      {sections.testCases.length ? (
        <Section title="Test cases">
          <div className="flex flex-col gap-2">
            {sections.testCases.map((testCase, index) => (
              <div
                // oxlint-disable-next-line react/no-array-index-key -- titles may repeat
                key={index}
                className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <Tag tone={priorities[testCase.priority]}>{testCase.priority}</Tag>
                  <span className="text-sm font-medium">{testCase.title}</span>
                </div>
                {testCase.steps.length ? (
                  <ol className="list-decimal ps-5 text-sm">
                    {testCase.steps.map((step, stepIndex) => (
                      // oxlint-disable-next-line react/no-array-index-key -- steps may repeat
                      <li key={stepIndex}>{step}</li>
                    ))}
                  </ol>
                ) : null}
                <p className="text-xs text-muted">Expected: {testCase.expected}</p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      {sections.testing.length ? (
        <Section title="Ideas by kind of testing">
          <div className="grid gap-3 md:grid-cols-2">
            {sections.testing.map((group) => (
              <div key={group.kind} className="flex flex-col gap-1">
                <span className="text-xs font-medium capitalize">{group.kind}</span>
                <List items={group.ideas} />
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      {sections.autotests.length ? (
        <Section title="Autotest ideas">
          <ul className="flex flex-col gap-1.5 text-sm">
            {sections.autotests.map((test, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- ideas may repeat
              <li key={index} className="flex flex-wrap items-center gap-1.5">
                <Tag tone="info">{test.level}</Tag>
                <span>{test.idea}</span>
                {test.testIds.map((id) => (
                  <Tag key={id} mono tone="code">
                    {id}
                  </Tag>
                ))}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {sections.risks.length ? (
        <Section title="Risks">
          <List items={sections.risks} />
        </Section>
      ) : null}
      {sections.questions.length ? (
        <Section title="Open questions">
          <List items={sections.questions} />
        </Section>
      ) : null}
    </div>
  )
}

function SummaryPanel({ view }: { view: QaTaskView }) {
  const summarize = useSummarizeQaTask(view.key)
  const summary: QaSummaryView | undefined = view.summary
  const run = () =>
    summarize.mutate(undefined, {
      onError: (error) => notify.error('No summary', messageOf(error)),
    })
  const button = (label: string, icon: typeof Sparkles) => {
    const Icon = icon
    return (
      <Button
        size="sm"
        variant={summary && !summary.stale ? 'secondary' : 'primary'}
        isDisabled={!view.can.summarize}
        isPending={summarize.isPending}
        onPress={run}
      >
        <Icon className="size-3.5" />
        {label}
      </Button>
    )
  }
  return (
    <Panel
      title="Summary for testing"
      description={
        summary
          ? `Written ${formatRelative(summary.at)} by ${summary.by.name} from ${summary.changes} changes${summary.model ? ` · ${summary.model}` : ''}`
          : 'What changed, whether and how to test it, test cases, autotest ideas and risks.'
      }
      actions={summary ? button('Regenerate', RefreshCw) : undefined}
    >
      <div className="flex flex-col gap-3">
        {!view.can.summarize && view.summarizeHint ? (
          <p className="text-xs text-muted">Cannot write a summary: {view.summarizeHint}.</p>
        ) : null}
        {summary?.stale ? (
          <Notice tone="warning" title="New changes since this summary">
            {stalenessText(summary.stale)}:{' '}
            <span className="mono text-xs">
              {[...summary.stale.added, ...summary.stale.updated, ...summary.stale.removed]
                .slice(0, 6)
                .map(changeLabel)
                .join(', ')}
            </span>
            . Regenerate to include them.
          </Notice>
        ) : null}
        {summarize.isPending ? (
          <p className="text-sm text-muted">The AI agent reads the changes; this takes a minute.</p>
        ) : null}
        {summary ? (
          <SummaryBody sections={summary.sections} />
        ) : (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted">
              No summary yet. It is written by the AI agent only when you ask and is kept until the
              next one.
            </p>
            {button('Summarize', Sparkles)}
          </div>
        )}
      </div>
    </Panel>
  )
}

function TestIds({ files }: { files: readonly TestIdFileChange[] }) {
  return (
    <Panel title="Test attributes" description="Added and removed across the task's changes.">
      <div className="flex flex-col gap-2">
        {files.map((file) => (
          <div key={file.file} className="flex flex-col gap-1">
            <span className="mono text-xs text-muted">{file.file}</span>
            <div className="flex flex-wrap gap-1">
              {file.added.map((ref) => (
                <Tag
                  key={`+${ref.attribute}=${ref.value}`}
                  mono
                  tone="success"
                  title={ref.attribute}
                >
                  + {ref.dynamic ? `{${ref.value}}` : ref.value}
                </Tag>
              ))}
              {file.removed.map((ref) => (
                <Tag
                  key={`-${ref.attribute}=${ref.value}`}
                  mono
                  tone="danger"
                  title={ref.attribute}
                >
                  − {ref.dynamic ? `{${ref.value}}` : ref.value}
                </Tag>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function Change({ change }: { change: QaChangeView }) {
  const kind = changeKinds[change.kind]
  const files = change.detail?.files ?? []
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  return (
    <li className="flex flex-col gap-1 border-t border-line py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={kind.tone} title={kind.hint}>
          {kind.label}
        </Tag>
        {unreviewed(change.kind) ? (
          <Tag tone="warning" dot title={kind.hint}>
            No review
          </Tag>
        ) : null}
        {change.mergeRequest?.draft ? <Tag>Draft</Tag> : null}
        {change.url ? (
          <a
            href={change.url}
            target="_blank"
            rel="noreferrer"
            className="mono inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
          >
            {change.id}
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <span className="mono text-xs text-muted">{change.id}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={change.title}>
          {change.mergeRequest?.title ?? change.title}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>
          into <span className="mono">{change.branch}</span>
          {change.mergeRequest ? (
            <>
              {' '}
              from <span className="mono">{change.mergeRequest.sourceBranch}</span>
            </>
          ) : null}
        </span>
        <span>{change.authors.join(', ')}</span>
        <span title={formatDateTime(change.at)}>{formatRelative(change.at)}</span>
        {change.commits.length > 1 ? <span>{change.commits.length} commits</span> : null}
        {files.length ? (
          <span>
            {files.length}
            {change.detail?.partial ? '+' : ''} files{' '}
            <span className="text-success">+{additions}</span>{' '}
            <span className="text-danger">−{deletions}</span>
          </span>
        ) : null}
        {change.detailError ? <span className="text-dim">{change.detailError}</span> : null}
      </div>
      {files.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted select-none">
            <FileCode2 className="inline size-3" /> Files
          </summary>
          <ul className="mono mt-1 flex flex-col gap-0.5 ps-4">
            {files.map((file) => (
              <li key={file.path} className="flex gap-2">
                <span className="w-24 shrink-0 text-dim">{file.status}</span>
                <span className="min-w-0 flex-1 truncate" title={file.path}>
                  {file.path}
                </span>
                <span className="text-success">+{file.additions}</span>
                <span className="text-danger">−{file.deletions}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  )
}

function Body({ view }: { view: QaTaskView }) {
  const testIds = testIdSummary(view.changes)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">{view.title || view.key}</h1>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="mono">{view.key}</span>
          {view.issue?.type ? <Tag>{view.issue.type}</Tag> : null}
          {view.issue?.status ? <Tag tone="info">{view.issue.status}</Tag> : null}
          {view.url ? (
            <a
              href={view.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              Open in the tracker <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
      </div>
      {view.pending > 0 ? (
        <Notice title="Reading repositories">
          {view.pending} repositories are not read yet; the task may have more changes.
        </Notice>
      ) : null}
      <SummaryPanel view={view} />
      {testIds.length ? <TestIds files={testIds} /> : null}
      {changesByRepo(view.changes).map((group) => (
        <Panel
          key={repoKey(group.repo)}
          title={<span className="mono">{group.repo.path}</span>}
          description={`${group.changes.length} ${group.changes.length === 1 ? 'change' : 'changes'}`}
        >
          <ul className="flex flex-col">
            {group.changes.map((change) => (
              <Change key={`${change.id}#${change.head}`} change={change} />
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  )
}

/**
 * One QA task: its title and tracker link, the AI summary for testing (written on request, with a
 * warning and Regenerate once new changes arrive), the test attributes its changes add and
 * remove, and its changes per repository with their kind, a "No review" mark for direct commits
 * and the files they touch.
 */
export function QaTaskPage() {
  const { key } = useParams({ from: '/app/releases/qa/$key' })
  const view = useQaTask(key)
  return (
    <Page crumbs={[{ label: 'QA', link: { to: '/releases/qa' } }, { label: key }]}>
      {view.isPending ? (
        <div className="flex flex-col gap-3">
          <Placeholder className="h-16" />
          <Placeholder className="h-48" />
          <Placeholder className="h-32" />
        </div>
      ) : view.isError ? (
        view.error instanceof ApiError && view.error.status === 404 ? (
          <EmptyState
            title={`No changes name ${key}`}
            description="Nothing in the last 90 days of the repositories you can read mentions it."
          />
        ) : (
          <ErrorState error={view.error} />
        )
      ) : (
        <Body view={view.data} />
      )}
    </Page>
  )
}
