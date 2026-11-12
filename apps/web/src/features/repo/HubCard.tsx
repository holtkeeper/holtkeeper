import type { HealthTone, RepoCardKey, RepoCardSegment, RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  BookOpen,
  Bot,
  Boxes,
  Braces,
  FileText,
  GitBranch,
  Images,
  Layers,
  type LucideIcon,
  MessageSquareCode,
  Package,
  Shield,
  Tag as TagIcon,
  Target,
  Workflow,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { healthTagTone } from '../../lib/home.ts'
import type { DeliveryCard } from '../../lib/repo-page.ts'
import { type RepoHubSearch, repoSplat } from '../../lib/repo.ts'
import { cellStatusWords } from '../../lib/repos.ts'
import { statusColor } from '../../ui/colors.ts'
import { Tag } from '../../ui/index.ts'

const segmentColor = (tone: HealthTone) =>
  tone === 'none' ? 'var(--dim)' : statusColor[healthTagTone[tone]]

const cardIcons: Record<RepoCardKey | DeliveryCard['key'], LucideIcon> = {
  security: Shield,
  libraries: Package,
  licenses: FileText,
  stack: Layers,
  'public-api': Braces,
  coverage: Target,
  bundles: Boxes,
  assets: Images,
  ci: Workflow,
  branches: GitBranch,
  releases: TagIcon,
  reviews: MessageSquareCode,
  work: Bot,
  knowledge: BookOpen,
}

/** Classes of the quiet "Open →" links of the hub. */
export const hubLinkClass =
  'inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-foreground no-underline hover:underline'

/** A quiet link with an arrow to a tab (and area) of the repository hub. */
export function HubLink({
  repo,
  search,
  children,
}: {
  repo: RepoRef
  search: RepoHubSearch
  children: ReactNode
}) {
  return (
    <Link
      to="/repos/$"
      params={{ _splat: repoSplat(repo) }}
      search={search}
      className={hubLinkClass}
    >
      {children}
      <ArrowRight className="size-3" />
    </Link>
  )
}

/** What a hub card shows: an Overview card from the server or a Delivery card. */
export interface HubCardView {
  key: RepoCardKey | DeliveryCard['key']
  label: string
  tone: HealthTone
  status: string
  value: string
  unit: string
  lines: readonly string[]
  segments?: readonly RepoCardSegment[]
}

/**
 * One card of the repository hub: icon, name and status tag, the headline value with its unit, an
 * optional segment bar (named for screen readers), up to two lines and `open` at the bottom.
 */
export function HubCard({ card, open }: { card: HubCardView; open?: ReactNode }) {
  const Icon = cardIcons[card.key]
  const mono = /\d/.test(card.value) && /[a-z]/i.test(card.value)
  return (
    <article className="flex min-w-0 flex-col gap-[7px] rounded-[10px] border border-line bg-sunk px-3 py-[11px]">
      <div className="flex min-w-0 items-center gap-[7px] text-[12.5px] font-semibold">
        <span className="grid size-6 shrink-0 place-items-center rounded-md border border-line bg-raise text-muted">
          <Icon className="size-[13px]" aria-hidden />
        </span>
        <span className="truncate">{card.label}</span>
        <Tag tone={healthTagTone[card.tone]} dot className="ms-auto">
          {card.status}
        </Tag>
      </div>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span
          className={`leading-tight font-semibold tracking-tight ${mono ? 'mono text-[18px]' : 'text-[20px]'}`}
        >
          {card.value}
        </span>
        <span className="truncate text-xs text-muted">{card.unit}</span>
      </div>
      {card.segments?.length ? (
        <div
          role="img"
          aria-label={card.segments
            .map(
              (segment) => `${Math.round(segment.share * 100)}% ${cellStatusWords[segment.tone]}`,
            )
            .join(', ')}
          className="flex h-[5px] gap-0.5 overflow-hidden rounded-[3px] bg-line-strong"
        >
          {card.segments.map((segment, index) => (
            <i
              key={index}
              className="block h-full"
              style={{ width: `${segment.share * 100}%`, background: segmentColor(segment.tone) }}
            />
          ))}
        </div>
      ) : (
        <div className="h-[5px]" aria-hidden />
      )}
      {card.lines.map((line, index) => (
        <span
          key={line}
          className={`truncate text-xs ${index ? 'text-dim' : 'text-muted'}`}
          title={line}
        >
          {line}
        </span>
      ))}
      {open ? <div className="mt-0.5">{open}</div> : null}
    </article>
  )
}
