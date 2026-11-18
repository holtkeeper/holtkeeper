import type { LearningOrigin, LearningStatus, LearningView, Scope } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Lightbulb } from 'lucide-react'
import { useState } from 'react'

import { useLearnings, useRepos, useTeamTitles } from '../../api/queries.ts'
import { neighbours } from '../../lib/flow.ts'
import {
  defaultLearningStatuses,
  isLearningOrigin,
  isLearningStatus,
  learningOrigins,
  learningStatusOf,
  learningStatuses,
  learningTiming,
  learningTotals,
  originLabel,
} from '../../lib/learnings.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { ruleScopeLabel } from '../../lib/rules.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  FilterButton,
  ListFooter,
  Placeholder,
  SearchInput,
  Strip,
  Table,
  Tag,
  Td,
  Th,
  Tr,
} from '../../ui/index.ts'
import { LearningSheet, useDecideLearning } from './LearningSheet.tsx'

/**
 * The Learnings tab: learnings filtered by status (pending and active at first), origin,
 * repository and text, with a summary strip, one row each with scope, origin, sources, uses,
 * votes and when it activates or expires. Pending rows carry Approve and Reject; a row opens the
 * learning's sheet (`?learning=<id>`), `creating` the form for a new one.
 */
export function LearningsTab({
  selected,
  creating,
  onOpen,
  onCloseCreating,
}: {
  selected: string | undefined
  creating: Scope | undefined
  onOpen: (id: string | undefined) => void
  onCloseCreating: () => void
}) {
  const titleOf = useTeamTitles()
  const repoList = useRepos().data?.repos ?? []
  const [statuses, setStatuses] = useState<LearningStatus[]>([...defaultLearningStatuses])
  const [origins, setOrigins] = useState<LearningOrigin[]>([])
  const [repo, setRepo] = useState<string>()
  const [text, setText] = useState('')
  const query = useDebounced(text, 250)
  const learnings = useLearnings({
    status: statuses,
    origin: origins,
    ...(repo ? { repo: parseRepoKey(repo) } : {}),
    text: query,
  })
  const decide = useDecideLearning()

  const list = learnings.data?.learnings ?? []
  const people = learnings.data?.people ?? {}
  const step = neighbours(
    list.map((learning) => learning.id),
    selected,
  )
  const current = list.find((learning) => learning.id === selected)
  const totals = learningTotals(list)
  const filtered = Boolean(origins.length || repo || query.trim())

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel text-[13px]">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <FilterButton
          label="Status"
          all="Any"
          options={learningStatuses.map((status) => ({ id: status.id, label: status.label }))}
          value={statuses}
          onChange={(ids) => setStatuses(ids.filter(isLearningStatus))}
        />
        <FilterButton
          label="Origin"
          all="Any"
          options={learningOrigins}
          value={origins}
          onChange={(ids) => setOrigins(ids.filter(isLearningOrigin))}
        />
        <FilterButton
          label="Repository"
          single
          all="Any"
          options={repoList.map((each) => ({ id: repoKey(each.repo), label: repoKey(each.repo) }))}
          value={repo ? [repo] : []}
          onChange={(ids) => setRepo(ids[0])}
        />
        <span className="flex-1" />
        <SearchInput
          aria-label="Filter learnings"
          placeholder="Filter by text"
          value={text}
          onChange={setText}
          className="w-56"
        />
      </div>
      <Strip
        label="Learnings summary"
        cells={[
          {
            value: totals.pending,
            label: 'pending',
            ...(totals.pending ? { tone: 'warning' as const } : {}),
            caption: (
              <Link
                to="/inbox"
                search={{ kind: 'learning' }}
                className="hover:text-foreground hover:underline"
              >
                also in Inbox
              </Link>
            ),
          },
          { value: totals.active, label: 'active' },
          { value: totals.expiringSoon, label: 'expire within 14 days' },
        ]}
      />
      {learnings.isPending ? (
        <Placeholder className="h-72" />
      ) : learnings.isError ? (
        <ErrorState error={learnings.error} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Lightbulb />}
          title={filtered ? 'Nothing matches' : 'No learnings here'}
          description={
            filtered
              ? 'Change or clear the filters to see more learnings.'
              : 'Holtkeeper learns one-sentence rules from replies to its review comments, from merged merge requests and from agents.'
          }
        />
      ) : (
        <Table label="Learnings">
          <thead>
            <tr>
              <Th className="w-full">Learning</Th>
              <Th>Scope</Th>
              <Th>Origin</Th>
              <Th align="right">Sources</Th>
              <Th align="right">Uses · acted on</Th>
              <Th align="right">Votes</Th>
              <Th>Status</Th>
              <Th>
                <span className="sr-only">Decide</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {list.map((learning) => (
              <LearningRow
                key={learning.id}
                learning={learning}
                scope={ruleScopeLabel(learning.scope, titleOf)}
                open={learning.id === selected}
                onOpen={() => onOpen(learning.id)}
                onDecide={(decision) => decide.run(learning, decision)}
                deciding={decide.isPending}
              />
            ))}
          </tbody>
        </Table>
      )}
      <ListFooter
        shown={list.length}
        total={list.length}
        noun="learnings"
        className="border-t border-line"
      />
      <LearningSheet
        learning={current}
        people={people}
        {...(creating ? { creating } : {})}
        {...(current && step.index >= 0 ? { index: step.index, total: list.length } : {})}
        {...(step.previous ? { onPrevious: () => onOpen(step.previous) } : {})}
        {...(step.next ? { onNext: () => onOpen(step.next) } : {})}
        onOpen={(id) => {
          onCloseCreating()
          onOpen(id)
        }}
        onClose={() => {
          onCloseCreating()
          if (selected) onOpen(undefined)
        }}
      />
    </div>
  )
}

function LearningRow({
  learning,
  scope,
  open,
  onOpen,
  onDecide,
  deciding,
}: {
  learning: LearningView
  scope: string
  open: boolean
  onOpen: () => void
  onDecide: (decision: 'approve' | 'reject') => void
  deciding: boolean
}) {
  const status = learningStatusOf(learning.status)
  const timing = learningTiming(learning)
  const votes = learning.votesUp + learning.votesDown
  return (
    <Tr selected={open} onClick={onOpen}>
      <Td valign="top" className="min-w-64 whitespace-normal">
        <span className="font-medium">{learning.text}</span>
        {learning.files?.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {learning.files.map((glob) => (
              <Tag key={glob} mono>
                {glob}
              </Tag>
            ))}
          </div>
        ) : null}
      </Td>
      <Td valign="top" className="whitespace-nowrap">
        <span
          className={learning.scope.all || learning.scope.teams?.length ? '' : 'mono text-[12px]'}
        >
          {scope}
        </span>
      </Td>
      <Td valign="top" className="whitespace-nowrap">
        {originLabel(learning.origin)}
      </Td>
      <Td valign="top" align="right" className="tabular">
        {learning.sources.length}
      </Td>
      <Td valign="top" align="right" className="tabular whitespace-nowrap">
        {learning.uses} · {learning.actedOn}
      </Td>
      <Td valign="top" align="right" className="tabular whitespace-nowrap">
        {votes ? `👍 ${learning.votesUp} · 👎 ${learning.votesDown}` : '—'}
      </Td>
      <Td valign="top" className="whitespace-nowrap">
        <Tag tone={timing?.soon && learning.status === 'active' ? 'warning' : status.tone} dot>
          {timing ? `${status.label} · ${timing.label.toLowerCase()}` : status.label}
        </Tag>
      </Td>
      <Td valign="top" align="right" onClick={(event) => event.stopPropagation()}>
        {learning.canEdit && learning.status === 'pending' ? (
          <span className="inline-flex gap-1">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={deciding}
              onPress={() => onDecide('approve')}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={deciding}
              onPress={() => onDecide('reject')}
            >
              Reject
            </Button>
          </span>
        ) : null}
      </Td>
    </Tr>
  )
}
