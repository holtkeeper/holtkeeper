import type { AiBudgetOverview, AiBudgetStatus, AiScopeCapView } from '@holtkeeper/api'
import { ArrowUpRight } from 'lucide-react'

import { useAiOverview, useCredentials, useDescribeScope } from '../../api/queries.ts'
import { useAgentTools, useAiBudget } from '../../api/settings-ai.ts'
import {
  type FeatureShare,
  budgetMarks,
  capStatus,
  featureBreakdown,
  featureColor,
  toolUsers,
} from '../../lib/ai-features.ts'
import { automaticLimit, budgetState, formatRatio, formatUsd } from '../../lib/ai-usage.ts'
import { formatDate } from '../../lib/format.ts'
import { settingAnchor } from '../../lib/settings-sections.ts'
import {
  ErrorState,
  Legend,
  LinkButton,
  Panel,
  Placeholder,
  Strip,
  type StripCell,
  Table,
  Tag,
  Td,
  Th,
  Tr,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { BudgetEditor } from './BudgetCard.tsx'

const toneColor = { success: 'var(--ok)', warning: 'var(--warn)', danger: 'var(--bad)' } as const

/**
 * The line over Settings › AI: the provider agents run on, this week's spend against the budget,
 * runs, failures and cache hits. Figures the viewer may not read are left out.
 */
export function AiStrip() {
  const { can } = useSession()
  const readAi = can('ai:read') || can('ai:admin')
  const budget = useAiBudget(readAi)
  const overview = useAiOverview(readAi)
  const credentials = useCredentials(can('credentials:read'))
  const provider = credentials.data?.credentials.find((credential) =>
    credential.usedBy?.some((use) => use.id === 'llm.provider'),
  )
  const totals = overview.data?.current.totals
  const cells: StripCell[] = [
    ...(provider ? [{ prefix: 'Agents run on', value: provider.name, label: '' }] : []),
    ...(budget.data
      ? [
          {
            prefix: 'This week',
            value: formatUsd(budget.data.spentUsd),
            label: budget.data.budget ? `of ${formatUsd(budget.data.budget.weeklyUsd)}` : '',
          },
          { value: budget.data.runs.toLocaleString('en'), label: 'runs' },
        ]
      : []),
    ...(totals
      ? [
          {
            value: totals.errors.toLocaleString('en'),
            label: 'failed',
            tone: totals.errors ? ('danger' as const) : ('none' as const),
          },
          {
            prefix: 'Cache hits',
            value: formatRatio(overview.data?.cacheHitRatio ?? 0),
            label: '',
          },
        ]
      : []),
  ]
  if (!cells.length) return null
  return <Strip cells={cells} label="AI at a glance" className="rounded-xl border border-line" />
}

function FeatureMeter({
  budget,
  features,
}: {
  budget: AiBudgetStatus
  features: readonly FeatureShare[]
}) {
  const marks = budgetMarks(budget)
  const width = (usd: number) => (marks.scaleUsd > 0 ? (usd / marks.scaleUsd) * 100 : 0)
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="meter"
        aria-label={`Spent ${formatUsd(budget.spentUsd)} of ${formatUsd(budget.weeklyUsd)}; warning at ${formatUsd(marks.warnUsd)}`}
        aria-valuemin={0}
        aria-valuemax={budget.weeklyUsd}
        aria-valuenow={Math.min(budget.spentUsd, budget.weeklyUsd)}
        className="relative flex h-3 gap-px overflow-visible rounded-md bg-sunk shadow-[inset_0_0_0_1px_var(--line)]"
      >
        {features.map((feature, index) => (
          <b
            key={feature.feature}
            className="h-full first:rounded-l-md"
            style={{
              width: `${width(feature.costUsd)}%`,
              background: featureColor(feature.feature, index),
            }}
          />
        ))}
        <span
          aria-hidden
          className="absolute -inset-y-1 w-px bg-warning"
          style={{ left: `${marks.warn}%` }}
        />
        <span
          aria-hidden
          className="absolute -inset-y-1 w-0.5 bg-foreground"
          style={{ left: `calc(${marks.stop}% - 2px)` }}
        />
      </div>
      <div className="relative h-4 mono text-[10px] text-dim">
        <span className="absolute left-0">$0</span>
        <span
          className="absolute -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${marks.warn}%` }}
        >
          Warn {formatUsd(marks.warnUsd)}
        </span>
        <span className="absolute right-0 whitespace-nowrap">
          {budget.action === 'block' ? 'Stop' : 'Limit'} {formatUsd(budget.weeklyUsd)}
        </span>
      </div>
    </div>
  )
}

function paceLine(budget: AiBudgetStatus): string {
  const warnUsd = (budget.weeklyUsd * budget.warnPercent) / 100
  const where =
    budget.forecastUsd >= budget.weeklyUsd
      ? 'over the limit'
      : budget.forecastUsd >= warnUsd
        ? 'past the warning line'
        : 'under the warning line'
  return `At this week's pace: ${formatUsd(budget.forecastUsd)} by Sunday, ${where}. Automatic work stops at ${formatUsd(automaticLimit(budget))}.`
}

const scopeKind = (cap: AiScopeCapView) => {
  const { groups = [], repos = [] } = cap.scope
  if (groups.length && !repos.length) return 'Group'
  if (repos.length && !groups.length) return 'Repository'
  return 'Mixed'
}

function UsedBar({ percent, color }: { percent: number; color: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className="block h-[5px] w-16 overflow-hidden rounded-[3px] bg-[var(--line-strong)]"
      >
        <b
          className="block h-full rounded-[3px]"
          style={{ width: `${Math.min(100, percent)}%`, background: color }}
        />
      </span>
      <span className="mono text-xs">{Math.round(percent)}%</span>
    </span>
  )
}

/**
 * Scoped `llm.budget` entries with this week's spend, then each feature's spend as read-only rows:
 * features have no caps of their own and count toward the org budget.
 */
function CapsTable({ overview, editable }: { overview: AiBudgetOverview; editable: boolean }) {
  const describeScope = useDescribeScope()
  const features = featureBreakdown(overview.byFeature)
  const orgUsd = overview.budget?.weeklyUsd ?? 0
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-[12.5px] font-medium">Caps for groups, repositories and features</h3>
        <span className="mono text-xs text-dim">{overview.scopes.length + features.length}</span>
        <span className="text-xs text-muted">
          The tightest matching cap wins. Each also counts toward the org budget.
        </span>
        <span className="flex-1" />
        {editable ? (
          <LinkButton
            size="sm"
            variant="secondary"
            to="/settings/$section"
            params={{ section: 'ai' }}
            hash={settingAnchor('llm.budget')}
          >
            Add cap
          </LinkButton>
        ) : null}
      </div>
      <Table label="Budget caps">
        <thead>
          <tr>
            <Th>Applies to</Th>
            <Th>Kind</Th>
            <Th align="right">Weekly cap</Th>
            <Th align="right">Spent</Th>
            <Th>Used</Th>
            <Th>Status</Th>
            <Th>When reached</Th>
          </tr>
        </thead>
        <tbody>
          {overview.scopes.map((cap) => {
            const status = capStatus(cap)
            return (
              <Tr key={cap.settingId}>
                <Td className="mono text-xs">{describeScope(cap.scope)}</Td>
                <Td>
                  <Tag>{scopeKind(cap)}</Tag>
                </Td>
                <Td align="right" className="mono">
                  {formatUsd(cap.weeklyUsd)}
                </Td>
                <Td align="right" className="mono">
                  {formatUsd(cap.spentUsd)}
                </Td>
                <Td>
                  <UsedBar percent={cap.percent} color={toneColor[status.tone]} />
                </Td>
                <Td>
                  <Tag tone={status.tone} dot>
                    {status.label}
                  </Tag>
                </Td>
                <Td className="text-xs">{cap.action === 'block' ? 'Block runs' : 'Only warn'}</Td>
              </Tr>
            )
          })}
          {features.map((feature) => (
            <Tr key={feature.feature}>
              <Td>
                {feature.label}{' '}
                <span className="text-xs text-dim">{feature.runs.toLocaleString('en')} runs</span>
              </Td>
              <Td>
                <Tag>Feature</Tag>
              </Td>
              <Td align="right" className="text-xs text-muted">
                No cap
              </Td>
              <Td align="right" className="mono">
                {formatUsd(feature.costUsd)}
              </Td>
              <Td>
                <UsedBar
                  percent={orgUsd > 0 ? (feature.costUsd / orgUsd) * 100 : 0}
                  color="var(--fg-muted)"
                />
              </Td>
              <Td>
                <Tag>Counts toward org</Tag>
              </Td>
              <Td className="text-xs text-muted">As the org budget</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {overview.scopes.length === 0 && features.length === 0 ? (
        <p className="text-xs text-muted">No caps and no spend this week.</p>
      ) : null}
    </div>
  )
}

/**
 * Settings › AI › Budgets: this week's spend split by feature against the broadest budget with its
 * warning and stop lines, the global budget editor for a global `settings:write`, and the caps.
 */
export function BudgetsPanel() {
  const { canGlobal } = useSession()
  const overview = useAiBudget()
  const writable = canGlobal('settings:write')
  return (
    <Panel
      variant="flush"
      title={<span id="budgets">Budgets</span>}
      description="Weekly, from Monday 00:00 in the instance time zone."
      actions={
        <LinkButton size="sm" variant="ghost" to="/ops/spend">
          Runs and daily cost in Ops › AI spend
          <ArrowUpRight className="size-3.5" />
        </LinkButton>
      }
      contentClassName="flex flex-col gap-5"
    >
      {overview.isPending ? (
        <Placeholder className="h-48" />
      ) : overview.isError ? (
        <ErrorState error={overview.error} />
      ) : (
        <BudgetsBody overview={overview.data} writable={writable} />
      )}
    </Panel>
  )
}

function BudgetsBody({ overview, writable }: { overview: AiBudgetOverview; writable: boolean }) {
  const describeScope = useDescribeScope()
  const { budget } = overview
  const features = featureBreakdown(overview.byFeature)
  const global = budget !== undefined && (budget.id === 'default' || budget.scope.all === true)
  const state = budget ? budgetState(budget) : undefined
  return (
    <>
      {budget && state ? (
        <div className="flex flex-col gap-3 rounded-xl border border-line p-3.5">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-xs text-muted">Spent this week</span>
            <span className="mono text-2xl font-semibold">{formatUsd(budget.spentUsd)}</span>
            <span className="text-xs text-muted">
              of <span className="mono">{formatUsd(budget.weeklyUsd)}</span> ·{' '}
              <span className="mono">{Math.round(budget.percent)}%</span>
            </span>
            <span className="flex-1" />
            {global ? null : <Tag mono>{describeScope(budget.scope)}</Tag>}
            <Tag tone={state.tone} dot>
              {state.label}
            </Tag>
          </div>
          <FeatureMeter budget={budget} features={features} />
          {features.length ? (
            <Legend
              label="Spend by feature"
              items={features.map((feature, index) => ({
                color: featureColor(feature.feature, index),
                label: (
                  <>
                    {feature.label} <span className="mono">{formatUsd(feature.costUsd)}</span>
                  </>
                ),
              }))}
            />
          ) : (
            <p className="text-xs text-muted">Nothing spent this week yet.</p>
          )}
          <p className="text-xs text-muted">{paceLine(budget)}</p>
        </div>
      ) : (
        <p className="text-sm text-muted">
          {formatUsd(overview.spentUsd)} spent this week in the repositories you can read; no budget
          covers them that you may see.
        </p>
      )}
      {budget && writable && global ? (
        <div className="flex flex-col gap-1">
          <BudgetEditor
            key={`${budget.id}:${budget.weeklyUsd}:${budget.reserveUsd}:${budget.warnPercent}:${budget.action}`}
            budget={budget}
          />
          <p className="text-xs text-muted">
            Past Warn at, people who may change the budget get one Inbox item that week.
            {overview.budgetChanged
              ? ` Changed ${formatDate(overview.budgetChanged.at)}.`
              : ' The defaults apply until it is saved.'}
          </p>
        </div>
      ) : null}
      <CapsTable overview={overview} editable={writable} />
    </>
  )
}

/** Settings › AI › Agent tools: what internal agents and MCP clients may call, read-only. */
export function AgentToolsPanel() {
  const tools = useAgentTools()
  const list = tools.data?.tools ?? []
  const writing = list.filter((tool) => !tool.readOnly).length
  return (
    <details id="tools" className="group flex flex-col gap-3 border-t border-line pt-3">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-2 text-[13px] font-semibold">
        Advanced: agent tools
        <span className="text-xs font-normal text-muted">
          {tools.data
            ? `${list.length} tools, ${writing} of them change something · the same for every provider`
            : 'The tools agents may call'}
        </span>
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        {tools.isPending ? (
          <Placeholder className="h-32" />
        ) : tools.isError ? (
          <ErrorState error={tools.error} />
        ) : (
          <Table label="Agent tools">
            <thead>
              <tr>
                <Th>Tool</Th>
                <Th>Toolset</Th>
                <Th>Used by</Th>
                <Th>Changes</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((tool) => (
                <Tr key={tool.name}>
                  <Td valign="top">
                    <div className="mono text-xs">{tool.name}</div>
                    <div className="line-clamp-2 max-w-xl text-xs text-muted">
                      {tool.description}
                    </div>
                  </Td>
                  <Td valign="top">
                    <Tag mono>{tool.toolset}</Tag>
                  </Td>
                  <Td valign="top" className="text-xs">
                    {toolUsers(tool.usedBy)}
                  </Td>
                  <Td valign="top">
                    {tool.readOnly ? <Tag>Read-only</Tag> : <Tag tone="warning">Writes</Tag>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="text-xs text-muted">
          Tools come with Holtkeeper and cannot be switched off here. Whether agents may change code
          at all is switched in Ops › Tasks.
        </p>
      </div>
    </details>
  )
}
