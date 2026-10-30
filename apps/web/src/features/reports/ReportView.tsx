import type { Report } from '@holtkeeper/api'
import { CalendarClock, GitBranch, GitCompareArrows, ListTree } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'

import { sectionAnchor } from '../../lib/analyses.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { repoKey } from '../../lib/repo.ts'
import { Chip, EmptyState, stagger } from '../../ui/index.ts'
import { BlockView } from './BlockView.tsx'
import { MetricCard } from './MetricCard.tsx'

function useActiveSection(ids: readonly string[]): string | undefined {
  const [active, setActive] = useState(ids[0])
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .toSorted((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: '-80px 0px -60% 0px' },
    )
    for (const id of ids) {
      const element = document.getElementById(id)
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [ids])
  return active
}

/**
 * Renders any analysis report: header, headline metrics with deltas, and its sections with a
 * table of contents. Knows nothing about the analysis kind.
 */
export function ReportView({ report }: { report: Report }) {
  const anchors = useMemo(
    () => report.sections.map((section) => sectionAnchor(section.id)),
    [report.sections],
  )
  const active = useActiveSection(anchors)
  const { subject } = report

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-5 shadow-surface">
        <h2 className="text-xl font-semibold tracking-tight">{report.title}</h2>
        {report.subtitle ? <p className="text-sm text-muted">{report.subtitle}</p> : null}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {subject?.repo ? <Chip>{repoKey(subject.repo)}</Chip> : null}
          {subject?.ref ? (
            <span className="inline-flex items-center gap-1 font-mono">
              <GitBranch className="size-3.5" />
              {subject.ref}
            </span>
          ) : null}
          {subject?.compareTo ? (
            <span className="inline-flex items-center gap-1">
              <GitCompareArrows className="size-3.5" />
              compared to <span className="font-mono">{subject.compareTo}</span>
            </span>
          ) : null}
          <span
            className="inline-flex items-center gap-1"
            title={formatDateTime(report.generatedAt)}
          >
            <CalendarClock className="size-3.5" />
            generated {formatRelative(report.generatedAt)}
          </span>
        </div>
      </header>

      {report.metrics.length ? (
        <motion.div {...stagger} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {report.metrics.map((metric) => (
            <MetricCard key={metric.id} metric={metric} />
          ))}
        </motion.div>
      ) : null}

      {report.sections.length === 0 ? (
        <EmptyState icon={<ListTree />} title="This report has no sections" />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_13rem]">
          <div className="flex min-w-0 flex-col gap-6">
            {report.sections.map((section, index) => (
              <motion.section
                key={section.id}
                id={anchors[index]}
                aria-labelledby={`${anchors[index]}-title`}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-40px' }}
                transition={{ duration: 0.3 }}
                className="flex scroll-mt-20 flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-surface"
              >
                <div>
                  <h2 id={`${anchors[index]}-title`} className="text-base font-semibold">
                    <a href={`#${anchors[index]}`} className="hover:underline">
                      {section.title}
                    </a>
                  </h2>
                  {section.description ? (
                    <p className="mt-0.5 text-sm text-muted">{section.description}</p>
                  ) : null}
                </div>
                {section.blocks.map((block, blockIndex) => (
                  <BlockView key={`${block.type}-${blockIndex}`} block={block} />
                ))}
              </motion.section>
            ))}
          </div>
          <nav aria-label="Report sections" className="hidden xl:block">
            <ul className="sticky top-20 flex flex-col gap-0.5 border-l border-separator text-sm">
              {report.sections.map((section, index) => {
                const current = active === anchors[index]
                return (
                  <li key={section.id} className="relative">
                    {current ? (
                      <motion.span
                        layoutId="report-toc"
                        className="absolute -left-px inset-y-0 w-0.5 rounded-full bg-accent"
                      />
                    ) : null}
                    <a
                      href={`#${anchors[index]}`}
                      aria-current={current ? 'location' : undefined}
                      className={`block truncate py-1 pl-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus ${current ? 'font-medium text-foreground' : 'text-muted'}`}
                    >
                      {section.title}
                    </a>
                  </li>
                )
              })}
            </ul>
          </nav>
        </div>
      )}
    </div>
  )
}
