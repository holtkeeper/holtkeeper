import {
  Activity,
  BookOpen,
  Box,
  CalendarClock,
  FileText,
  Flag,
  Gauge,
  GitFork,
  GitMerge,
  GitPullRequest,
  Image,
  Languages,
  Layers,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  MessageSquareCode,
  MousePointerClick,
  Network,
  Package,
  Scale,
  ScanSearch,
  ScrollText,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tag,
  Telescope,
  Waves,
} from 'lucide-react'

export interface Node<Id extends string> {
  id: Id
  icon: LucideIcon
  label: string
  detail: string
}

export type TriggerId = 'webhook' | 'tag' | 'schedule' | 'comment' | 'panel'
export type StageId = 'policies' | 'queue' | 'checkout' | 'tools'
export type OutputId = 'comments' | 'mrs' | 'reports' | 'slack' | 'confluence'

export const triggers: Node<TriggerId>[] = [
  {
    id: 'webhook',
    icon: GitPullRequest,
    label: 'Merge request opened',
    detail: 'webhook · mr.opened',
  },
  { id: 'tag', icon: Tag, label: 'Tag pushed', detail: 'v2.4.0' },
  {
    id: 'schedule',
    icon: CalendarClock,
    label: 'Schedule',
    detail: 'weekdays 03:00 · skip nights & weekends',
  },
  {
    id: 'comment',
    icon: MessageSquare,
    label: 'Comment command',
    detail: '/holtkeeper port games',
  },
  { id: 'panel', icon: MousePointerClick, label: 'Panel button', detail: 'Run propagate' },
]

export const stages: Node<StageId>[] = [
  {
    id: 'policies',
    icon: ShieldCheck,
    label: 'MR policies',
    detail: 'approve, label, merge, skip analyses',
  },
  { id: 'queue', icon: Layers, label: 'Queue', detail: 'per-credential limits, retries' },
  {
    id: 'checkout',
    icon: Box,
    label: 'Checkout + toolchain',
    detail: 'mise in a container or pod',
  },
  {
    id: 'tools',
    icon: BookOpen,
    label: 'Knowledge & code tools',
    detail: 'team decisions, outlines, release notes',
  },
]

export const analyzers: { id: string; icon: LucideIcon }[] = [
  { id: 'review', icon: Sparkles },
  { id: 'audit', icon: ShieldAlert },
  { id: 'changelog', icon: ScrollText },
  { id: 'bundle', icon: Package },
  { id: 'depgraph', icon: Network },
  { id: 'quality', icon: ScanSearch },
  { id: 'licenses', icon: Scale },
  { id: 'assets', icon: Image },
  { id: 'i18n', icon: Languages },
  { id: 'delivery', icon: Activity },
  { id: 'fleet', icon: Telescope },
  { id: 'release-risk', icon: Gauge },
  { id: 'propagate', icon: Waves },
  { id: 'port', icon: GitFork },
  { id: 'tracker', icon: Flag },
]

export const outputs: Node<OutputId>[] = [
  {
    id: 'comments',
    icon: MessageSquareCode,
    label: 'Inline MR comments',
    detail: 'with suggestion blocks',
  },
  { id: 'mrs', icon: GitMerge, label: 'Merge requests', detail: 'one per repository' },
  { id: 'reports', icon: LayoutDashboard, label: 'Panel reports', detail: 'compare any two runs' },
  { id: 'slack', icon: Send, label: 'Slack', detail: 'summaries, webhooks' },
  { id: 'confluence', icon: FileText, label: 'Confluence', detail: 'one marked section' },
]

export interface Scenario {
  id: string
  pill: string
  trigger: TriggerId
  stages: Partial<Record<StageId, string>>
  analyzers: string[]
  results: Partial<Record<OutputId, string>>
  caption: string
}

export const scenarios: Scenario[] = [
  {
    id: 'review',
    pill: 'MR opened',
    trigger: 'webhook',
    stages: {
      policies: 'no rule skips it · enqueue review',
      queue: 'gitlab token · slot 2 of 4',
      checkout: 'node + pnpm from the repo',
      tools: '3 decisions in scope',
    },
    analyzers: ['review', 'quality'],
    results: { comments: '3 suggestions · 1 major', reports: 'verdict: changes requested' },
    caption:
      'MR !482 opened. Policies let it through, review reads the diff with the team’s decisions and posts three inline suggestions and a summary.',
  },
  {
    id: 'wave',
    pill: '@company/ui 3.0',
    trigger: 'panel',
    stages: {
      queue: '8 repositories · 2 at a time',
      checkout: 'writable checkout per repo',
      tools: 'release notes 2.9 → 3.0',
    },
    analyzers: ['propagate'],
    results: { mrs: '8 opened · 2 fixed · 1 draft', slack: 'wave summary posted' },
    caption:
      '@company/ui 3.0 released. Eight merge requests, one per game: five pass after the bump, two break and the agent fixes them from the release notes, one stays a draft labeled needs-attention.',
  },
  {
    id: 'release',
    pill: 'tag v2.4.0',
    trigger: 'tag',
    stages: { queue: 'one job per analyzer', checkout: 'tag v2.4.0, history to v2.3.0' },
    analyzers: ['changelog', 'bundle', 'depgraph', 'quality', 'release-risk'],
    results: { reports: 'risk 34/100 · medium', slack: 'what to test, for QA' },
    caption:
      'Tag v2.4.0 pushed. Changelog, bundle diff against v2.3.0, dependency and quality deltas, then a release risk of 34/100 with what to test.',
  },
  {
    id: 'nightly',
    pill: 'nightly',
    trigger: 'schedule',
    stages: { queue: 'spread until 07:00', checkout: 'mirror cache, shallow' },
    analyzers: ['audit', 'licenses', 'fleet', 'tracker'],
    results: {
      mrs: 'audit fixes · lockfiles only',
      confluence: 'flags table updated',
      reports: 'drift, licenses',
    },
    caption:
      'Weekdays at 03:00. Audits fix vulnerable dependencies in merge requests, fleet drift and licenses are recorded, and the feature-flag table in Confluence is rewritten.',
  },
  {
    id: 'port',
    pill: '/holtkeeper port',
    trigger: 'comment',
    stages: {
      policies: 'command event · enqueue port',
      queue: 'group games · 7 targets',
      checkout: 'source patch + targets',
      tools: 'path remaps, outlines',
    },
    analyzers: ['port'],
    results: { mrs: '7 targets · 1 re-implemented', comments: 'results table on !311' },
    caption:
      '/holtkeeper port games on !311. The patch goes to every sibling repository; where it does not apply, the agent re-implements it, and the source MR gets a table of results.',
  },
]
