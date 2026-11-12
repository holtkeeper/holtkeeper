import type { AiBudgetStatus, AiSpendCaps } from '@holtkeeper/api'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { useSettingMutations, useSettings } from '../../api/queries.ts'
import {
  type BudgetDraft,
  automaticLimit,
  budgetBar,
  budgetDraft,
  budgetState,
  formatUsd,
  parseBudgetDraft,
  untilLabel,
} from '../../lib/ai-usage.ts'
import { formatDate, formatDateTime } from '../../lib/format.ts'
import { Button, Legend, Panel, SegmentedTabs, Tag, TextField, notify } from '../../ui/index.ts'
import { ScopeBadge } from '../access/ScopeEditor.tsx'

const toneColor = { success: 'var(--ok)', warning: 'var(--warn)', danger: 'var(--bad)' } as const

const forecastFill = (color: string) =>
  `repeating-linear-gradient(135deg, color-mix(in oklab, ${color} 45%, transparent) 0 3px, transparent 3px 6px)`

const stopsLabel = (at: string) =>
  new Date(at).toLocaleString('en', { weekday: 'long', hour: '2-digit', minute: '2-digit' })

function paceNote(budget: AiBudgetStatus): string {
  const limit = automaticLimit(budget)
  if (budget.spentUsd >= budget.weeklyUsd)
    return budget.action === 'block'
      ? 'The weekly limit is used up: new runs are refused until the week resets.'
      : 'The weekly limit is used up; runs go on because the budget only warns.'
  if (budget.reserveUsd > 0 && budget.spentUsd >= limit)
    return `Automatic work stopped at ${formatUsd(limit)}; only work people start runs until the week resets.`
  if (budget.automaticStopsAt)
    return `At this pace automatic work stops ${stopsLabel(budget.automaticStopsAt)}.`
  return `At this pace automatic work keeps running all week, with ${formatUsd(Math.max(limit - budget.forecastUsd, 0))} to spare.`
}

function Meter({ budget }: { budget: AiBudgetStatus }) {
  const bar = budgetBar(budget)
  const color = toneColor[budgetState(budget).tone]
  const limit = automaticLimit(budget)
  const third = budget.weeklyUsd / 3
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="relative mt-5 h-3 rounded-md bg-sunk shadow-[inset_0_0_0_1px_var(--line)]"
        role="meter"
        aria-label={`Spent ${formatUsd(budget.spentUsd)} of ${formatUsd(budget.weeklyUsd)}. Forecast ${formatUsd(budget.forecastUsd)} by week end. Automatic work stops at ${formatUsd(limit)}.`}
        aria-valuemin={0}
        aria-valuemax={budget.weeklyUsd}
        aria-valuenow={Math.min(budget.spentUsd, budget.weeklyUsd)}
      >
        {bar.forecast > bar.spent ? (
          <span
            className="absolute inset-y-0"
            style={{
              left: `${bar.spent}%`,
              width: `${bar.forecast - bar.spent}%`,
              background: forecastFill(color),
              borderRight: `1.5px solid ${color}`,
            }}
          />
        ) : null}
        <span
          className="absolute inset-y-0 left-0 rounded-l-md"
          style={{ width: `${bar.spent}%`, background: color }}
        />
        {budget.reserveUsd > 0 ? (
          <>
            <span
              className="absolute -inset-y-1.5 w-0.5 rounded-sm bg-foreground"
              style={{ left: `${bar.reserve}%` }}
            />
            <span
              className="absolute -top-5 -translate-x-full whitespace-nowrap pr-1.5 text-[11px]"
              style={{ left: `${bar.reserve}%` }}
            >
              Automatic work stops at <span className="font-mono">{formatUsd(limit)}</span>
            </span>
          </>
        ) : null}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-dim">
        {[0, 1, 2, 3].map((step) => (
          <span key={step}>{formatUsd(Math.round(third * step))}</span>
        ))}
      </div>
    </div>
  )
}

/** The inline editor of the global `llm.budget` entry, or of the default budget when none is stored. */
export function BudgetEditor({ budget }: { budget: AiBudgetStatus }) {
  const client = useQueryClient()
  const { put } = useSettingMutations()
  const settings = useSettings()
  const [draft, setDraft] = useState<BudgetDraft>(() => budgetDraft(budget))
  const parsed = parseBudgetDraft(draft)
  const entry = settings.data?.settings.find((setting) => setting.id === budget.id)
  const changedBy = entry?.updatedBy
    ? (settings.data?.people[entry.updatedBy]?.name ?? entry.updatedBy)
    : undefined
  const saved = budgetDraft(budget)
  const dirty =
    draft.weeklyUsd !== saved.weeklyUsd ||
    draft.reserveUsd !== saved.reserveUsd ||
    draft.warnPercent !== saved.warnPercent ||
    draft.action !== saved.action
  const automatic =
    'value' in parsed ? formatUsd(automaticLimit(parsed.value)) : formatUsd(automaticLimit(budget))

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!('value' in parsed)) return
    put.mutate(
      {
        ...(budget.id === 'default' ? {} : { id: budget.id }),
        key: 'llm.budget',
        scope: { all: true },
        value: parsed.value,
      },
      {
        onSuccess: () => {
          notify.success('Budget saved')
          void client.invalidateQueries({ queryKey: ['ai'] })
        },
        onError: (error) => notify.error('Could not save the budget', String(error)),
      },
    )
  }

  return (
    <form
      aria-label="Edit weekly budget"
      onSubmit={save}
      className="flex flex-col gap-3 rounded-[10px] border border-line bg-raise p-3"
    >
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-medium">
        <span>Edit budget</span>
        <span className="flex-1" />
        {entry ? (
          <span className="text-xs font-normal text-muted" title={formatDateTime(entry.updatedAt)}>
            Changed{changedBy ? ` by ${changedBy}` : ''} on {formatDate(entry.updatedAt)}
          </span>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label="Weekly limit, $"
          value={draft.weeklyUsd}
          onChange={(weeklyUsd) => setDraft({ ...draft, weeklyUsd })}
          mono
        />
        <TextField
          label="Kept for people, $"
          value={draft.reserveUsd}
          onChange={(reserveUsd) => setDraft({ ...draft, reserveUsd })}
          description={`Automatic stops at ${automatic}`}
          mono
        />
        <TextField
          label="Warn at, %"
          value={draft.warnPercent}
          onChange={(warnPercent) => setDraft({ ...draft, warnPercent })}
          description="Shows as close to the limit from here"
          mono
        />
        <div className="flex flex-col gap-1">
          <span className="text-sm">When reached</span>
          <SegmentedTabs
            aria-label="When the limit is reached"
            items={[
              { id: 'block', label: 'Block runs' },
              { id: 'warn', label: 'Warn' },
            ]}
            selected={draft.action}
            onSelect={(id) => setDraft({ ...draft, action: id === 'warn' ? 'warn' : 'block' })}
          />
        </div>
      </div>
      {'error' in parsed ? (
        <p role="alert" className="text-xs text-bad">
          {parsed.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">
          Applies to every repository without a narrower budget.
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          isDisabled={!dirty || put.isPending}
          onPress={() => setDraft(saved)}
        >
          Cancel
        </Button>
        <Button
          variant="secondary"
          size="sm"
          type="submit"
          isDisabled={!dirty || 'error' in parsed}
          isPending={put.isPending}
        >
          Save budget
        </Button>
      </div>
    </form>
  )
}

function NarrowerBudget({ budget }: { budget: AiBudgetStatus }) {
  const state = budgetState(budget)
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(60px,120px)_auto] items-center gap-3 py-1.5 text-[12.5px]">
      <div className="flex min-w-0 items-center gap-2">
        <ScopeBadge scope={budget.scope} />
        <Tag>{budget.action === 'block' ? 'Blocks' : 'Warns'}</Tag>
        {state.tone === 'success' ? null : (
          <Tag tone={state.tone} dot>
            {state.label}
          </Tag>
        )}
      </div>
      <span
        className="block h-[5px] overflow-hidden rounded-[3px] bg-[var(--line-strong)]"
        role="img"
        aria-label={`${Math.round(budget.percent)} percent used`}
      >
        <b
          className="block h-full rounded-[3px]"
          style={{
            width: `${Math.min(100, budget.percent)}%`,
            background: toneColor[state.tone],
          }}
        />
      </span>
      <span className="font-mono">
        {formatUsd(budget.spentUsd)}{' '}
        <span className="text-dim">/ {formatUsd(budget.weeklyUsd)}</span>
      </span>
    </li>
  )
}

const capRow = 'grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 py-1.5 text-[12.5px]'

function Caps({ caps }: { caps: AiSpendCaps }) {
  return (
    <>
      <li className={capRow}>
        <div className="flex min-w-0 items-center gap-2">
          <Tag>Cap</Tag>
          <Link to="/ops/tasks" className="hover:underline">
            Write tasks
          </Link>
        </div>
        <span className="text-xs text-muted">
          per task unless it sets its own, up to{' '}
          <span className="font-mono">{formatUsd(caps.writeTaskMaxUsd)}</span>
        </span>
        <span className="font-mono">{formatUsd(caps.writeTaskUsd)}</span>
      </li>
      <li className={capRow}>
        <div className="flex min-w-0 items-center gap-2">
          <Tag>Cap</Tag>
          <Link to="/chat" className="hover:underline">
            Chat replies
          </Link>
        </div>
        <span className="text-xs text-muted">
          {caps.chatReplyAvgUsd === undefined ? (
            'per reply'
          ) : (
            <>
              average <span className="font-mono">{formatUsd(caps.chatReplyAvgUsd)}</span> per reply
            </>
          )}
        </span>
        <span className="font-mono">{formatUsd(caps.chatReplyUsd)}</span>
      </li>
    </>
  )
}

/**
 * The weekly budget: this week's spend against the limit with the forecast and the point where
 * automatic work stops, an inline `llm.budget` editor for global `settings:write`, the narrower
 * budgets the viewer may read and the read-only caps of one write task and one chat reply. The
 * page's filters never narrow it.
 */
export function BudgetCard({
  budget,
  narrower,
  caps,
  writable,
}: {
  budget: AiBudgetStatus
  narrower: readonly AiBudgetStatus[]
  caps: AiSpendCaps
  writable: boolean
}) {
  const state = budgetState(budget)
  const color = toneColor[state.tone]
  const global = budget.id === 'default' || budget.scope.all === true
  return (
    <Panel
      variant="flush"
      title="Weekly budget"
      actions={
        <>
          {global ? <Tag>All repositories</Tag> : <ScopeBadge scope={budget.scope} />}
          <Tag>{budget.action === 'block' ? 'Blocks runs' : 'Warns'}</Tag>
          <Tag tone={state.tone} dot>
            {state.label}
          </Tag>
        </>
      }
      contentClassName="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-2xl font-semibold">{formatUsd(budget.spentUsd)}</span>
        <span className="text-xs text-muted">
          of <span className="font-mono">{formatUsd(budget.weeklyUsd)}</span> ·{' '}
          <span className="font-mono">{Math.round(budget.percent)}%</span>
        </span>
        <span className="flex-1" />
        <span className="text-xs text-muted" title={formatDateTime(budget.week.to)}>
          Resets {formatDateTime(budget.week.to)} · in {untilLabel(budget.week.to)}
        </span>
      </div>
      <Meter budget={budget} />
      <Legend
        label="Budget legend"
        items={[
          { color, label: <>Spent {formatUsd(budget.spentUsd)}</> },
          {
            color: `color-mix(in oklab, ${color} 45%, transparent)`,
            label: (
              <>
                Forecast to week end +{formatUsd(Math.max(budget.forecastUsd - budget.spentUsd, 0))}
              </>
            ),
          },
          ...(budget.reserveUsd > 0
            ? [
                {
                  color: 'var(--fg)',
                  label: <>Last {formatUsd(budget.reserveUsd)} kept for work people start</>,
                },
              ]
            : []),
        ]}
      />
      <p className="text-xs text-muted">{paceNote(budget)}</p>
      {writable && global ? (
        <BudgetEditor
          key={`${budget.id}:${budget.weeklyUsd}:${budget.reserveUsd}:${budget.warnPercent}:${budget.action}`}
          budget={budget}
        />
      ) : null}
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-dim">
          {narrower.length ? 'Narrower budgets and caps' : 'Caps'}
        </span>
        <ul className="flex flex-col divide-y divide-line">
          {narrower.map((entry) => (
            <NarrowerBudget key={entry.id} budget={entry} />
          ))}
          <Caps caps={caps} />
        </ul>
      </div>
    </Panel>
  )
}
