import type { Block, Tone } from '@holtkeeper/api'
import { CircleAlert, CircleCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react'
import { motion } from 'motion/react'

import { toneColor } from '../../../lib/units.ts'
import { EmptyState, fadeItem, stagger } from '../../../ui/index.ts'

const icons: Record<Tone, typeof Info> = {
  neutral: Info,
  info: Info,
  good: CircleCheck,
  warning: TriangleAlert,
  bad: OctagonAlert,
}

/** Problems and remarks as callouts, worst tone first as the report orders them. */
export function IssuesBlock({ block }: { block: Extract<Block, { type: 'issues' }> }) {
  if (block.items.length === 0) return <EmptyState icon={<CircleCheck />} title="No issues" />
  return (
    <motion.ul {...stagger} className="flex flex-col gap-2">
      {block.items.map((issue) => {
        const Icon = icons[issue.tone] ?? CircleAlert
        const color = toneColor[issue.tone]
        return (
          <motion.li
            key={issue.id}
            {...fadeItem}
            className="flex gap-3 rounded-xl border p-3"
            style={{
              borderColor: `color-mix(in oklab, ${color} 35%, var(--border))`,
              background: `color-mix(in oklab, ${color} 7%, transparent)`,
            }}
          >
            <Icon className="mt-0.5 size-4 shrink-0" style={{ color }} aria-label={issue.tone} />
            <div className="flex min-w-0 flex-col gap-1">
              {issue.href ? (
                <a
                  href={issue.href}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium hover:underline"
                >
                  {issue.title}
                </a>
              ) : (
                <span className="font-medium">{issue.title}</span>
              )}
              {issue.detail ? (
                <p className="whitespace-pre-wrap text-sm text-muted">{issue.detail}</p>
              ) : null}
              {issue.tags?.length ? (
                <div className="flex flex-wrap gap-1">
                  {issue.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-md bg-default px-1.5 py-0.5 font-mono text-[11px]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </motion.li>
        )
      })}
    </motion.ul>
  )
}
