import type { Card, CardBlock } from '@holtkeeper/chat'
import { type SlackBlock, renderSlackMessage } from '@holtkeeper/chat-slack'

import type { CompareRequest, PreviewRow, RepoResult } from './compare-state.ts'

/** Button commands of the preview; the interactions route maps them back. */
export const COMPARE_CONFIRM = 'compare confirm'
export const COMPARE_CANCEL = 'compare cancel'

/** Repositories one summary lists in full; more are counted. */
const SUMMARY_REPOS = 10
const SUMMARY_TASKS = 5
const SUMMARY_BREAKING = 5

type SlackText = { text: string; blocks: SlackBlock[] }

const keyOf = (repo: { forge: string; path: string }) => `${repo.forge}:${repo.path}`

const repoLabel = (row: { repo: { path: string } }) => row.repo.path

const versionOf = (side: PreviewRow['from']) =>
  side?.version ?? side?.tag ?? (side ? 'unknown' : '?')

/** Rows the run compares: both versions known and different. */
export const comparableRows = (preview: readonly PreviewRow[]) =>
  preview.filter((row) => row.range !== undefined)

const previewLine = (row: PreviewRow) => {
  const head = `**${repoLabel(row)}**`
  if (!row.from || !row.to) return `${head}: ${row.problem ?? 'cannot be compared'}`
  const sides = `${row.from.environment} \`${versionOf(row.from)}\` → ${row.to.environment} \`${versionOf(row.to)}\``
  return `${head}: ${sides}${row.problem ? ` (${row.problem})` : ''}`
}

/** The preview: what the bot understood, with buttons to start or cancel when anything is comparable. */
export function previewMessage(request: CompareRequest, preview: readonly PreviewRow[]): SlackText {
  const comparable = comparableRows(preview).length
  const blocks: CardBlock[] = [
    {
      type: 'text',
      text: `I understood: compare ${request.from ?? '?'} with ${request.to ?? '?'} for`,
    },
    ...(preview.length > 0
      ? [{ type: 'list' as const, items: preview.map((row) => ({ text: previewLine(row) })) }]
      : []),
    ...(request.unresolved.length > 0
      ? [
          {
            type: 'text' as const,
            text: `I could not find: ${request.unresolved.map((name) => `\`${name}\``).join(', ')}.`,
          },
        ]
      : []),
    ...(request.focus.length > 0
      ? [{ type: 'context' as const, text: `Looking at: ${request.focus.join(', ')}` }]
      : []),
    ...(comparable > 0
      ? [
          {
            type: 'actions' as const,
            actions: [
              { label: 'Start comparison', command: COMPARE_CONFIRM, style: 'primary' as const },
              { label: 'Cancel', command: COMPARE_CANCEL },
            ],
          },
          {
            type: 'context' as const,
            text: 'Press Start comparison, or mention me in this thread to correct or confirm it.',
          },
        ]
      : [
          {
            type: 'context' as const,
            text: 'Nothing to compare yet. Mention me in this thread to correct the request.',
          },
        ]),
  ]
  return renderSlackMessage({ title: 'Compare environments', blocks })
}

/** A plain reply in the thread, without a heading. */
export const textMessage = (text: string): SlackText =>
  renderSlackMessage({ blocks: [{ type: 'text', text }] })

/** The message posted when a run starts. */
export function startedMessage(preview: readonly PreviewRow[]): SlackText {
  const rows = comparableRows(preview)
  return renderSlackMessage({
    blocks: [
      {
        type: 'steps',
        steps: rows.map((row) => ({
          label: repoLabel(row),
          status: 'running',
          detail: `\`${row.range?.from}\` → \`${row.range?.to}\``,
        })),
      },
      {
        type: 'context',
        text: `Check started for ${rows.length === 1 ? '1 repository' : `${rows.length} repositories`}: changelog, tasks, dependencies and API changes. I will post the summary here.`,
      },
    ],
  })
}

const repoBlocks = (row: PreviewRow, result: RepoResult | undefined): CardBlock[] => {
  const range = row.range
  const sides =
    row.from && row.to
      ? `${row.from.environment} \`${versionOf(row.from)}\` → ${row.to.environment} \`${versionOf(row.to)}\``
      : ''
  if (!range || !result) return [{ type: 'text', text: previewLine(row) }]
  if (result.error || !result.comparison)
    return [
      { type: 'heading', text: repoLabel(row), detail: sides, tone: 'bad' },
      { type: 'text', text: `Comparison failed: ${result.error ?? 'no result'}` },
    ]
  const comparison = result.comparison
  const breakingEntries = comparison.entries.filter((entry) => entry.breaking)
  const breakingItems = comparison.breaking?.items ?? []
  const breakingCount = Math.max(breakingEntries.length, breakingItems.length)
  const facts = [
    `${comparison.commitCount}${comparison.capped ? '+' : ''} commits`,
    `${comparison.tasks.length} tasks`,
    ...(comparison.dependencies ? [`${comparison.dependencies.length} dependency changes`] : []),
    `${breakingCount} breaking`,
  ]
  const direction = range.reversed ? ` (${row.to?.environment} is behind)` : ''
  const links = [
    ...(comparison.reportUrl ? [`[Full report](${comparison.reportUrl})`] : []),
    ...(comparison.compareUrl ? [`[Diff](${comparison.compareUrl})`] : []),
  ]
  const breakingLines = (
    breakingItems.length > 0 ? breakingItems : breakingEntries.map((entry) => entry.text)
  ).slice(0, SUMMARY_BREAKING)
  const analysis =
    comparison.breaking?.status === 'running'
      ? 'API analysis is still running.'
      : comparison.breaking?.status === 'unavailable'
        ? 'API analysis is unavailable.'
        : undefined
  return [
    {
      type: 'heading',
      text: repoLabel(row),
      detail: `${sides}${direction}`,
      tone: breakingCount > 0 ? 'warning' : 'good',
    },
    {
      type: 'text',
      text: `${facts.join(' · ')}${links.length > 0 ? `  ${links.join(' · ')}` : ''}`,
    },
    ...(comparison.summary ? [{ type: 'text' as const, text: comparison.summary }] : []),
    ...(breakingLines.length > 0
      ? [
          {
            type: 'list' as const,
            items: breakingLines.map((line) => ({ text: line, tone: 'warning' as const })),
          },
        ]
      : []),
    ...(comparison.tasks.length > 0
      ? [
          {
            type: 'list' as const,
            items: comparison.tasks.slice(0, SUMMARY_TASKS).map((task) => ({
              text: `${task.key}${task.title ? ` ${task.title}` : ''}${task.status ? ` (${task.status})` : ''}`,
              ...(task.url && { url: task.url }),
            })),
          },
        ]
      : []),
    ...(analysis ? [{ type: 'context' as const, text: analysis }] : []),
  ]
}

/**
 * The summary of a finished run: per repository the two versions, counts, breaking changes,
 * the first tasks and links to the full report; then the AI overview when there is one.
 */
export function summaryMessage(input: {
  request: CompareRequest
  preview: readonly PreviewRow[]
  results: readonly RepoResult[]
  overview?: string
}): SlackText {
  const shown = input.preview.slice(0, SUMMARY_REPOS)
  const card: Card = {
    title: `Compared ${input.request.from ?? '?'} with ${input.request.to ?? '?'}`,
    blocks: [
      ...(input.overview ? [{ type: 'text' as const, text: input.overview }] : []),
      ...shown.flatMap((row, index) => [
        ...(index > 0 || input.overview ? [{ type: 'divider' as const }] : []),
        ...repoBlocks(
          row,
          input.results.find((result) => keyOf(result.repo) === keyOf(row.repo)),
        ),
      ]),
      ...(input.preview.length > shown.length
        ? [{ type: 'context' as const, text: `…and ${input.preview.length - shown.length} more` }]
        : []),
      { type: 'context', text: 'Mention me in this thread with follow-up questions.' },
    ],
  }
  return renderSlackMessage(card)
}
