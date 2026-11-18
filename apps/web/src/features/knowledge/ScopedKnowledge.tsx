import type { RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'

import { type RuleQuery } from '../../api/endpoints.ts'
import { useLearnings, useRules, useTeamTitles } from '../../api/queries.ts'
import { defaultLearningStatuses, learningStatusOf, learningTiming } from '../../lib/learnings.ts'
import { activationLabels, activationOf, agentsLabel, ruleScopeLabel } from '../../lib/rules.ts'
import { ErrorState, LinkButton, Placeholder, Tag } from '../../ui/index.ts'

function Heading({
  title,
  to,
}: {
  title: string
  to: '/knowledge/rules' | '/knowledge/learnings'
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      <LinkButton to={to} variant="ghost" size="sm">
        Open in Knowledge
        <ExternalLink className="size-3.5" />
      </LinkButton>
    </div>
  )
}

/**
 * The panel rules a repository or team gets, as a compact list linking to each rule on
 * Knowledge › Rules.
 */
export function ScopedRules({ query, title }: { query: RuleQuery; title: string }) {
  const titleOf = useTeamTitles()
  const rules = useRules(query)
  return (
    <section className="flex flex-col gap-2">
      <Heading title={title} to="/knowledge/rules" />
      {rules.isPending ? (
        <Placeholder className="h-24" />
      ) : rules.isError ? (
        <ErrorState error={rules.error} />
      ) : rules.data.rules.length === 0 ? (
        <p className="text-sm text-muted">No panel rule applies here.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-panel">
          {rules.data.rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
              <Link
                to="/knowledge/rules"
                search={{ rule: rule.id }}
                className="min-w-0 flex-1 truncate font-medium hover:underline"
              >
                {rule.title}
              </Link>
              <span className="text-xs text-muted">{ruleScopeLabel(rule.scope, titleOf)}</span>
              <Tag>{activationLabels[activationOf(rule)]}</Tag>
              <span className="text-xs text-muted">{agentsLabel(rule.agents)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Pending and active learnings whose scope covers a repository, linking to Knowledge › Learnings. */
export function ScopedLearnings({ repo }: { repo: RepoRef }) {
  const learnings = useLearnings({ repo, status: defaultLearningStatuses })
  return (
    <section className="flex flex-col gap-2">
      <Heading title="Learnings" to="/knowledge/learnings" />
      {learnings.isPending ? (
        <Placeholder className="h-24" />
      ) : learnings.isError ? (
        <ErrorState error={learnings.error} />
      ) : learnings.data.learnings.length === 0 ? (
        <p className="text-sm text-muted">No pending or active learning applies here.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-panel">
          {learnings.data.learnings.map((learning) => {
            const status = learningStatusOf(learning.status)
            const timing = learningTiming(learning)
            return (
              <li
                key={learning.id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]"
              >
                <Link
                  to="/knowledge/learnings"
                  search={{ learning: learning.id }}
                  className="min-w-0 flex-1 hover:underline"
                >
                  {learning.text}
                </Link>
                <Tag tone={status.tone} dot>
                  {timing ? `${status.label} · ${timing.label.toLowerCase()}` : status.label}
                </Tag>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
