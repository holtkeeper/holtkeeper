import {
  CalendarClock,
  FlaskConical,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Layers,
  type LucideIcon,
  ZapOff,
  RefreshCcw,
  Rocket,
  Sparkles,
  Tag as TagIcon,
  Tags,
  Terminal,
  FolderPlus,
  Zap,
} from 'lucide-react'
import type { ReactNode } from 'react'

import {
  type ActionKind,
  type AutomationEvent,
  type AutomationNode,
  type RuleKind,
  type RuleRef,
  ruleKind,
} from '../../lib/automation-flow.ts'
import type { StatusTone } from '../../ui/colors.ts'
import { Tag } from '../../ui/index.ts'

const eventIcons: Record<AutomationEvent, LucideIcon> = {
  push: GitBranch,
  tag: TagIcon,
  mergeRequest: GitPullRequest,
  label: Tags,
  command: Terminal,
  newRepo: FolderPlus,
  schedule: CalendarClock,
  freshness: RefreshCcw,
}

const actionIcons: Record<ActionKind, LucideIcon> = {
  analyzer: FlaskConical,
  review: Sparkles,
  release: Rocket,
  policy: GitMerge,
  analyzers: Layers,
}

function Line({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium">
      <Icon className="size-3.5 shrink-0 text-muted" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

const kindLabels: Record<RuleKind, string> = {
  trigger: 'Trigger',
  schedule: 'Schedule',
  policy: 'Policy',
  builtin: 'Built in',
}

/** A status badge a rule node shows instead of its kind, e.g. a failing schedule. */
export type RuleBadge = { label: string; tone: StatusTone }

/**
 * The renderer of automation canvas nodes. A rule shows an AI tag when it may call a model, then
 * `Off` when disabled, else the badge `badgeOf` gives it, else its kind.
 */
export function automationNodeRenderer(
  badgeOf: (ref: RuleRef) => RuleBadge | undefined = () => undefined,
) {
  return function renderAutomationNode(node: AutomationNode): ReactNode {
    if (node.kind === 'event')
      return <Line icon={eventIcons[node.data.event]}>{node.data.label}</Line>
    if (node.kind === 'action')
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <Line icon={actionIcons[node.data.action]}>{node.data.label}</Line>
          {node.data.ai ? (
            <Tag tone="code" className="ml-auto">
              AI
            </Tag>
          ) : null}
        </span>
      )
    const { title, chips, enabled, ai, ref } = node.data
    const badge = enabled ? badgeOf(ref) : undefined
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <Line icon={enabled ? Zap : ZapOff}>{title}</Line>
          <span className="ml-auto flex shrink-0 gap-1">
            {ai ? <Tag tone="code">AI</Tag> : null}
            {!enabled ? (
              <Tag>Off</Tag>
            ) : badge ? (
              <Tag tone={badge.tone} dot>
                {badge.label}
              </Tag>
            ) : (
              <Tag>{kindLabels[ruleKind(ref)]}</Tag>
            )}
          </span>
        </span>
        {chips.length ? (
          <span className="flex min-w-0 gap-1 overflow-hidden" title={chips.join(' · ')}>
            {chips.slice(0, 3).map((chip) => (
              <span
                key={chip}
                className="shrink-0 truncate rounded border border-line bg-raise px-1.5 text-[11px] text-muted"
              >
                {chip}
              </span>
            ))}
            {chips.length > 3 ? (
              <span className="shrink-0 text-[11px] text-dim">+{chips.length - 3}</span>
            ) : null}
          </span>
        ) : null}
      </div>
    )
  }
}
