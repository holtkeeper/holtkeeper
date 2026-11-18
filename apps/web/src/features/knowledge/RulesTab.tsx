import type { RuleView, Scope } from '@holtkeeper/api'
import { ScrollText } from 'lucide-react'
import { useState } from 'react'

import { useKnownTeams, useRepos, useRules, useTeamTitles } from '../../api/queries.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { personOf } from '../../lib/people.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { activationLabels, activationOf, agentsLabel, ruleScopeLabel } from '../../lib/rules.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import {
  EmptyState,
  ErrorState,
  FilterButton,
  ListFooter,
  Placeholder,
  SearchInput,
  Table,
  Tag,
  Td,
  Th,
  Tr,
} from '../../ui/index.ts'
import { RuleSheet } from './RuleSheet.tsx'

/**
 * The Rules tab: panel rules filtered by team, repository and text, one row each with its scope
 * in words, file globs, agents, activation and last edit. A row opens the rule's sheet
 * (`?rule=<id>`); `creating` opens the form for a new one.
 */
export function RulesTab({
  selected,
  creating,
  onOpen,
  onCloseCreating,
}: {
  selected: string | undefined
  /** Scope a new rule starts with, while the New rule form is open. */
  creating: Scope | undefined
  onOpen: (id: string | undefined) => void
  onCloseCreating: () => void
}) {
  const titleOf = useTeamTitles()
  const teams = useKnownTeams()
  const repoList = useRepos().data?.repos ?? []
  const [team, setTeam] = useState<string>()
  const [repo, setRepo] = useState<string>()
  const [text, setText] = useState('')
  const query = useDebounced(text, 250)
  const rules = useRules({
    ...(team ? { team } : {}),
    ...(repo ? { repo: parseRepoKey(repo) } : {}),
    text: query,
  })

  const list = rules.data?.rules ?? []
  const step = neighbours(
    list.map((rule) => rule.id),
    selected,
  )
  const current = list.find((rule) => rule.id === selected)
  const filtered = Boolean(team || repo || query.trim())

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel text-[13px]">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <FilterButton
          label="Team"
          single
          all="Any"
          options={teams.map((key) => ({ id: key, label: titleOf(key) }))}
          value={team ? [team] : []}
          onChange={(ids) => setTeam(ids[0])}
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
          aria-label="Filter rules"
          placeholder="Filter by text"
          value={text}
          onChange={setText}
          className="w-56"
        />
      </div>
      {rules.isPending ? (
        <Placeholder className="h-72" />
      ) : rules.isError ? (
        <ErrorState error={rules.error} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title={filtered ? 'Nothing matches' : 'No rules yet'}
          description={
            filtered
              ? 'Change or clear the filters to see more rules.'
              : 'Rules people write here reach every review, task, chat and release note run in their scope, next to the rules files repositories carry.'
          }
        />
      ) : (
        <Table label="Rules">
          <thead>
            <tr>
              <Th className="w-full">Rule</Th>
              <Th>Scope</Th>
              <Th>Applies</Th>
              <Th>Agents</Th>
              <Th align="right">Version</Th>
              <Th>Last edit</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                scope={ruleScopeLabel(rule.scope, titleOf)}
                open={rule.id === selected}
                onOpen={() => onOpen(rule.id)}
              />
            ))}
          </tbody>
        </Table>
      )}
      <ListFooter
        shown={list.length}
        total={list.length}
        noun="rules"
        className="border-t border-line"
      />
      <RuleSheet
        rule={current}
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

function RuleRow({
  rule,
  scope,
  open,
  onOpen,
}: {
  rule: RuleView
  scope: string
  open: boolean
  onOpen: () => void
}) {
  const activation = activationOf(rule)
  const editor = personOf({}, rule.updatedBy ?? rule.author)
  return (
    <Tr selected={open} onClick={onOpen}>
      <Td valign="top" className="min-w-56 whitespace-normal">
        <span className="font-medium">{rule.title}</span>
        {rule.description && activation === 'requested' ? (
          <div className="mt-0.5 text-xs text-muted">{rule.description}</div>
        ) : null}
      </Td>
      <Td valign="top" className="whitespace-nowrap">
        <span className={rule.scope.all || rule.scope.teams?.length ? '' : 'mono text-[12px]'}>
          {scope}
        </span>
      </Td>
      <Td valign="top">
        {activation === 'files' ? (
          <span className="flex flex-wrap gap-1">
            {(rule.files ?? []).map((glob) => (
              <Tag key={glob} mono>
                {glob}
              </Tag>
            ))}
          </span>
        ) : (
          <Tag tone={activation === 'requested' ? 'info' : 'default'}>
            {activationLabels[activation]}
          </Tag>
        )}
      </Td>
      <Td valign="top" className="whitespace-nowrap">
        {agentsLabel(rule.agents)}
      </Td>
      <Td valign="top" align="right" className="mono">
        {rule.version}
      </Td>
      <Td valign="top" className="whitespace-nowrap">
        <span className="flex flex-col leading-tight">
          <span className={editor.known ? '' : 'mono text-[12px]'}>{editor.name}</span>
          <span className="text-xs text-dim" title={formatDateTime(rule.updatedAt)}>
            {formatRelative(rule.updatedAt)}
          </span>
        </span>
      </Td>
    </Tr>
  )
}
