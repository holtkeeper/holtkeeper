import type {
  AcceptLearningsResult,
  Family,
  GuideScopeKey,
  GuideSectionName,
  LearningCandidateView,
  LearningSource,
  LearningSourceKind,
  PersonView,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Check, ExternalLink, GraduationCap, Pencil, X } from 'lucide-react'
import { useEffect, useEffectEvent, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useAcceptLearnings,
  useGroupTitles,
  useLearningMutations,
  useLearnings,
  useRepos,
} from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import { type GroupTitleOf } from '../../lib/group-titles.ts'
import { type Space, guideSections, scopeLabel, sectionLabel, spaceKey } from '../../lib/guide.ts'
import { foldOtherTeams } from '../../lib/home-scope.ts'
import {
  type ConfidenceLevel,
  type LearningSort,
  acceptedBySection,
  isAutoAccepted,
  confidenceAria,
  confidenceLabel,
  confidenceLevels,
  evidenceOf,
  filterLearnings,
  learningSorts,
  learningSourceKinds,
  learningsInSpace,
  selectableIds,
  selectionAfter,
  sourceCounts,
  sourceKindLabel,
  suggestedScopeOf,
} from '../../lib/learnings.ts'
import { repoKey } from '../../lib/repo.ts'
import { isEditableTarget } from '../../lib/slash-focus.ts'
import {
  Button,
  Count,
  EmptyState,
  ErrorState,
  FilterButton,
  Kbd,
  ListFooter,
  OtherTeams,
  Placeholder,
  SegmentedTabs,
  Select,
  SelectAllTh,
  SelectTd,
  Strip,
  Table,
  Tag,
  Td,
  TextField,
  Th,
  Tooltip,
  Tr,
  notify,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { Byline } from './parts.tsx'

const COLUMNS = 8

const failed = (title: string) => (error: Error) => notify.error(title, messageOf(error))

const isSection = (value: string): value is GuideSectionName =>
  guideSections.some((s) => s.id === value)

const sectionIds = guideSections.map((s) => s.id)

/**
 * Learning candidates of a space as a table: rules learned from review replies or proposed over
 * MCP, with their evidence, source and a 1–5 confidence. Rows are selected and accepted together
 * (`POST /api/learnings/accept`, one request per chosen scope), or accepted, edited and rejected
 * one at a time. Accepted rules are counted per Guide section; rejected ones and those the
 * `learnings.autoAccept` policy accepted stay hidden until asked for, and an auto-accepted rule can
 * be confirmed (accepted again by a person) or rejected, which takes it out of the Guide. `repos` are the `forge:path` keys the space covers.
 */
export function LearningsTable({
  space,
  families,
  repos,
}: {
  space: Space
  families: readonly Family[]
  repos: readonly string[]
}) {
  const { can } = useSession()
  const { homeGroups } = useScope()
  const learnings = useLearnings(space.kind === 'repo' ? { repo: space.repo } : {})
  const repoList = useRepos(can('repos:read'))
  const acceptMany = useAcceptLearnings()
  const [source, setSource] = useState<LearningSourceKind>()
  const [sections, setSections] = useState<GuideSectionName[]>([])
  const [confidence, setConfidence] = useState<ConfidenceLevel[]>([])
  const [sort, setSort] = useState<LearningSort>('evidence')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [scopes, setScopes] = useState<Record<string, GuideScopeKey>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [showRejected, setShowRejected] = useState(false)
  const [showAuto, setShowAuto] = useState(false)
  const [focused, setFocused] = useState<string>()
  const single = useLearningMutations()

  if (learnings.isPending) return <Placeholder className="h-72" />
  if (learnings.isError) return <ErrorState error={learnings.error} />

  const { people } = learnings.data
  const all = learningsInSpace(learnings.data.candidates, space, repos)
  const proposed = all.filter((c) => c.status === 'proposed')
  const rejected = all.filter((c) => c.status === 'rejected')
  const autoAccepted = all.filter(isAutoAccepted)
  const shown = filterLearnings(
    proposed,
    { ...(source ? { source } : {}), sections, confidence },
    sort,
  )
  const groupsOf = new Map(
    (repoList.data?.repos ?? []).map((summary) => [repoKey(summary.repo), summary.groups]),
  )
  const folded = foldOtherTeams(
    shown,
    space.kind === 'all' ? homeGroups : [],
    (candidate) => groupsOf.get(candidate.repo) ?? [],
  )
  const ids = selectableIds(shown)
  const chosen = shown.filter((c) => selected.has(c.id) && ids.includes(c.id))
  const counts = sourceCounts(proposed)
  const accepted = acceptedBySection(all, sectionIds)
  const scopeOf = (candidate: LearningCandidateView) =>
    scopes[candidate.id] ??
    (candidate.acceptedScope && candidate.scopes.includes(candidate.acceptedScope)
      ? candidate.acceptedScope
      : suggestedScopeOf(candidate))

  const acceptSelected = async () => {
    const batches = new Map<GuideScopeKey | undefined, string[]>()
    for (const candidate of chosen) {
      const scope = scopeOf(candidate)
      batches.set(scope, [...(batches.get(scope) ?? []), candidate.id])
    }
    const result: AcceptLearningsResult = { accepted: [], failed: [] }
    try {
      for (const [scope, batch] of batches) {
        // oxlint-disable-next-line no-await-in-loop -- one request per scope, in order
        const done = await acceptMany.mutateAsync({ ids: batch, ...(scope ? { scope } : {}) })
        result.accepted.push(...done.accepted)
        result.failed.push(...done.failed)
      }
    } catch (error) {
      notify.error('Not accepted', messageOf(error))
      return
    }
    setSelected(selectionAfter(result))
    setErrors(Object.fromEntries(result.failed.map((failure) => [failure.id, failure.error])))
    if (result.accepted.length)
      notify.success(
        `${plural(result.accepted.length, 'rule')} accepted`,
        result.failed.length ? `${plural(result.failed.length, 'candidate')} stayed` : undefined,
      )
    else notify.error('Nothing accepted', result.failed[0]?.error)
  }

  const visible = [...folded.mine, ...folded.others]
  const focusedCandidate = visible.find((candidate) => candidate.id === focused)
  const targets = chosen.length ? chosen : focusedCandidate ? [focusedCandidate] : []
  const acceptTargets = async () => {
    if (chosen.length) return acceptSelected()
    const candidate = focusedCandidate
    if (!candidate || !ids.includes(candidate.id)) return
    const scope = scopeOf(candidate)
    acceptMany.mutate(
      { ids: [candidate.id], ...(scope ? { scope } : {}) },
      {
        onSuccess: (done) =>
          done.accepted.length
            ? notify.success('Rule accepted')
            : notify.error('Not accepted', done.failed[0]?.error),
        onError: (error) => notify.error('Not accepted', messageOf(error)),
      },
    )
  }
  const rejectTargets = () => {
    for (const candidate of targets.filter((each) => each.canDecide))
      single.reject.mutate(candidate.id, {
        onSuccess: () => notify.success('Rule rejected'),
        onError: (error) => notify.error('Not rejected', messageOf(error)),
      })
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    if (isEditableTarget(event.target) || !visible.length) return
    const key = event.key.toLowerCase()
    const index = visible.findIndex((candidate) => candidate.id === focused)
    if (key === 'j' || key === 'k') {
      event.preventDefault()
      const next =
        key === 'j'
          ? Math.min(visible.length - 1, index + 1)
          : Math.max(0, index < 0 ? 0 : index - 1)
      setFocused(visible[next]?.id)
    } else if (key === 'x' && focusedCandidate && ids.includes(focusedCandidate.id)) {
      event.preventDefault()
      const next = new Set(selected)
      if (next.has(focusedCandidate.id)) next.delete(focusedCandidate.id)
      else next.add(focusedCandidate.id)
      setSelected(next)
    } else if (key === 'p' && targets.length) {
      event.preventDefault()
      void acceptTargets()
    } else if (key === 'd' && targets.length) {
      event.preventDefault()
      rejectTargets()
    }
  }

  const row = (candidate: LearningCandidateView) => (
    <CandidateRow
      key={candidate.id}
      focused={candidate.id === focused}
      candidate={candidate}
      families={families}
      people={people}
      selected={selected}
      onSelect={setSelected}
      selectable={ids.includes(candidate.id)}
      scope={scopeOf(candidate)}
      onScope={(scope) => setScopes((previous) => ({ ...previous, [candidate.id]: scope }))}
      {...(errors[candidate.id] ? { error: errors[candidate.id] } : {})}
    />
  )

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel text-[13px]">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <SegmentedTabs
          aria-label="Source"
          selected={source ?? 'all'}
          onSelect={(id) => setSource(learningSourceKinds.find((kind) => kind === id))}
          items={[
            {
              id: 'all',
              label: (
                <>
                  All <Count>{counts.all}</Count>
                </>
              ),
            },
            ...learningSourceKinds.map((kind) => ({
              id: kind,
              label: (
                <>
                  {sourceKindLabel[kind]} <Count>{counts[kind]}</Count>
                </>
              ),
            })),
          ]}
        />
        <span className="flex-1" />
        <FilterButton
          label="Section"
          all="All"
          options={guideSections.map((s) => ({ id: s.id, label: s.label }))}
          value={sections}
          onChange={(next) => setSections(next.filter(isSection))}
        />
        <FilterButton
          label="Confidence"
          options={confidenceLevels.map((level) => ({ id: level, label: level }))}
          value={confidence}
          onChange={(next) =>
            setConfidence(confidenceLevels.filter((level) => next.includes(level)))
          }
        />
        <FilterButton
          label="Sort"
          single
          all="Evidence"
          options={learningSorts}
          value={[sort]}
          onChange={(next) =>
            setSort(learningSorts.find((s) => s.id === next[0])?.id ?? 'evidence')
          }
        />
        {ids.length ? (
          <Button
            variant="primary"
            size="sm"
            isDisabled={!chosen.length}
            isPending={acceptMany.isPending}
            onPress={() => void acceptSelected()}
          >
            <Check className="size-3.5" />
            {chosen.length ? `Accept ${chosen.length} selected` : 'Accept selected'}
          </Button>
        ) : null}
      </div>
      <Strip
        label="Learnings summary"
        cells={[
          {
            value: proposed.length,
            label: 'candidates waiting for a person',
            ...(proposed.length
              ? {
                  caption: (
                    <Link
                      to="/inbox"
                      search={{ kind: 'learning' }}
                      className="hover:text-foreground hover:underline"
                    >
                      also in Inbox
                    </Link>
                  ),
                }
              : {}),
          },
          {
            prefix: 'from',
            value: counts['review-reply'],
            label: 'review replies',
            caption: `· ${counts.merged} merged · ${counts.mcp} over MCP`,
          },
          ...(chosen.length ? [{ value: chosen.length, label: 'selected', end: true }] : []),
        ]}
      />
      {shown.length === 0 ? (
        <EmptyState
          icon={<GraduationCap />}
          title={proposed.length ? 'No candidates match' : 'No candidates'}
          description={
            proposed.length
              ? 'Change or clear the filters to see more candidates.'
              : 'When someone answers a review comment with feedback, the rule it teaches waits here for a person.'
          }
        />
      ) : (
        <Table label="Learning candidates">
          <thead>
            <tr>
              <SelectAllTh
                ids={ids}
                selected={selected}
                onChange={setSelected}
                label="Select all candidates"
              />
              <CandidateColumns />
            </tr>
          </thead>
          <tbody>
            {folded.mine.map(row)}
            <OtherTeams
              variant="row"
              colSpan={COLUMNS}
              count={folded.others.length}
              teams={folded.teams}
              noun={{ one: 'candidate' }}
            >
              {folded.others.map(row)}
            </OtherTeams>
          </tbody>
        </Table>
      )}
      <ListFooter
        shown={shown.length}
        total={proposed.length}
        noun="candidates"
        className="border-t border-line"
        caption={chosen.length ? `· ${chosen.length} selected` : undefined}
        hints={
          <>
            Navigate <Kbd>J</Kbd>
            <Kbd>K</Kbd> · select <Kbd>X</Kbd> · accept <Kbd>P</Kbd> · reject <Kbd>D</Kbd>
          </>
        }
      />
      <KeyListener onKey={onKey} />
      <div className="grid gap-3 border-t border-line p-3.5 md:grid-cols-2">
        <section className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-sunk px-3.5 py-3">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold">Accepted rules live in the Guide</h3>
            <span className="flex-1" />
            <span className="mono text-dim">{accepted.reduce((sum, r) => sum + r.count, 0)}</span>
          </div>
          <p className="text-xs text-muted">
            Accepting adds the rule to the section&apos;s learned rules for the chosen space.
          </p>
          {accepted.length ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
              {accepted.map(({ section, count }) => (
                <Link
                  key={section}
                  to="/knowledge/guide"
                  search={{ space: spaceKey(space), section }}
                  className="hover:underline"
                >
                  {sectionLabel(section)} <span className="mono text-dim">{count}</span>
                </Link>
              ))}
            </div>
          ) : null}
          {autoAccepted.length ? (
            <div>
              <Button variant="secondary" size="sm" onPress={() => setShowAuto((v) => !v)}>
                {showAuto ? 'Hide' : 'Show'} {autoAccepted.length} auto-accepted
              </Button>
            </div>
          ) : null}
        </section>
        <section className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-sunk px-3.5 py-3">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold">Rejected</h3>
            <span className="flex-1" />
            <span className="mono text-dim">{rejected.length}</span>
          </div>
          <p className="text-xs text-muted">
            Rejected candidates are kept so the same lesson is not proposed again.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {rejected.length ? (
              <Button variant="secondary" size="sm" onPress={() => setShowRejected((v) => !v)}>
                {showRejected ? 'Hide' : 'Show'} {rejected.length} rejected
              </Button>
            ) : null}
            <span className="flex-1" />
            <Link to="/quality/reviews" className="text-xs hover:underline">
              Reactions on review comments are in Quality › Reviews
            </Link>
          </div>
        </section>
      </div>
      {showAuto && autoAccepted.length ? (
        <Table label="Auto-accepted rules">
          <thead>
            <tr>
              <Th>
                <span className="sr-only">Selection</span>
              </Th>
              <CandidateColumns />
            </tr>
          </thead>
          <tbody>
            {autoAccepted.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                families={families}
                people={people}
                selected={selected}
                onSelect={setSelected}
                selectable={false}
                scope={scopeOf(candidate)}
                onScope={(scope) =>
                  setScopes((previous) => ({ ...previous, [candidate.id]: scope }))
                }
              />
            ))}
          </tbody>
        </Table>
      ) : null}
      {showRejected && rejected.length ? (
        <Table label="Rejected candidates">
          <thead>
            <tr>
              <Th>
                <span className="sr-only">Selection</span>
              </Th>
              <CandidateColumns />
            </tr>
          </thead>
          <tbody>
            {rejected.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                families={families}
                people={people}
                selected={selected}
                onSelect={setSelected}
                selectable={false}
                scope={scopeOf(candidate)}
                onScope={(scope) =>
                  setScopes((previous) => ({ ...previous, [candidate.id]: scope }))
                }
              />
            ))}
          </tbody>
        </Table>
      ) : null}
    </div>
  )
}

const suggestedKinds: Record<LearningCandidateView['suggestedScope'], string> = {
  repo: 'the repository',
  family: 'its family',
  group: 'its team',
}

const suggestedLabel = (
  candidate: LearningCandidateView,
  families: readonly Family[],
  titleOf: GroupTitleOf,
) => {
  const key = candidate.targetScope ?? suggestedScopeOf(candidate)
  return key ? scopeLabel(key, families, titleOf) : suggestedKinds[candidate.suggestedScope]
}

const CandidateColumns = () => (
  <>
    <Th className="w-full">Candidate rule</Th>
    <Th>Section</Th>
    <Th align="right">Evidence</Th>
    <Th>Sources</Th>
    <Th>Confidence</Th>
    <Th>Promote to</Th>
    <Th>
      <span className="sr-only">Actions</span>
    </Th>
  </>
)

function SourceCell({ candidate }: { candidate: LearningCandidateView }) {
  const [first, ...rest] = candidate.sources
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Tag>{sourceKindLabel[candidate.sourceKind]}</Tag>
      {first ? <SourceLink source={first} /> : null}
      {rest.length ? <span className="mono text-xs text-dim">+{rest.length}</span> : null}
    </span>
  )
}

function SourceLink({ source }: { source: LearningSource }) {
  const label = `!${source.mergeRequest}`
  const title = `${source.repo} · @${source.author}`
  return source.url ? (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      title={title}
      onClick={(event) => event.stopPropagation()}
      className="mono inline-flex items-center gap-1 text-xs hover:underline"
    >
      {label}
      <ExternalLink className="size-3 text-muted" />
    </a>
  ) : (
    <span className="mono text-xs" title={title}>
      {label}
    </span>
  )
}

function ConfidenceBars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span role="img" aria-label={confidenceAria(value)} className="inline-flex items-end gap-0.5">
        {[1, 2, 3, 4, 5].map((step) => (
          <i
            key={step}
            className={`h-[11px] w-1 rounded-[1px] ${step <= value ? 'bg-foreground' : 'bg-line-strong'}`}
          />
        ))}
      </span>
      <span className="text-muted">{confidenceLabel(value)}</span>
    </span>
  )
}

/** Calls the newest `onKey` for every key press on the page while mounted. */
function KeyListener({ onKey }: { onKey: (event: KeyboardEvent) => void }) {
  const handle = useEffectEvent(onKey)
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handle(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
  return null
}

function CandidateRow({
  focused = false,
  candidate,
  families,
  people,
  selected,
  onSelect,
  selectable,
  scope,
  onScope,
  error,
}: {
  focused?: boolean
  candidate: LearningCandidateView
  families: readonly Family[]
  people: Readonly<Record<string, PersonView>>
  selected: ReadonlySet<string>
  onSelect: (next: Set<string>) => void
  selectable: boolean
  scope: GuideScopeKey | undefined
  onScope: (scope: GuideScopeKey) => void
  error?: string
}) {
  const titleOf = useGroupTitles()
  const { accept, edit, reject } = useLearningMutations()
  const [draft, setDraft] = useState<{ rule: string; section: GuideSectionName } | null>(null)
  const pending = accept.isPending || edit.isPending || reject.isPending

  const saveEdit = () =>
    draft &&
    edit.mutate(
      { id: candidate.id, input: { rule: draft.rule.trim(), section: draft.section } },
      { onSuccess: () => setDraft(null), onError: failed('Not saved') },
    )

  return (
    <Tr selected={focused}>
      {selectable ? (
        <SelectTd
          id={candidate.id}
          selected={selected}
          onChange={onSelect}
          label={`Select: ${candidate.rule}`}
        />
      ) : (
        <Td />
      )}
      <Td valign="top" className="min-w-72 whitespace-normal">
        {draft ? (
          <TextField
            aria-label="Rule"
            value={draft.rule}
            onChange={(rule) => setDraft({ ...draft, rule })}
          />
        ) : (
          <span>{candidate.rule}</span>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="mono">{candidate.repo}</span>
          {isAutoAccepted(candidate) ? (
            <Byline
              verb="accepted"
              id={candidate.decidedBy}
              at={candidate.decidedAt}
              people={people}
            />
          ) : null}
          {candidate.status === 'rejected' ? (
            <Byline
              verb="rejected"
              id={candidate.decidedBy}
              at={candidate.decidedAt}
              people={people}
            />
          ) : null}
          {candidate.proposal ? (
            <Byline
              verb="proposed"
              id={candidate.proposal.by}
              at={candidate.createdAt}
              people={people}
            />
          ) : null}
        </div>
        {candidate.proposal ? (
          <p className="mt-0.5 text-xs text-muted">{candidate.proposal.reason}</p>
        ) : null}
        {error ? <p className="mt-1 text-xs text-bad">{error}</p> : null}
      </Td>
      <Td valign="top">
        {draft ? (
          <Select
            aria-label="Section"
            className="w-36"
            options={guideSections.map((s) => ({ id: s.id, label: s.label }))}
            value={draft.section}
            onChange={(id) => isSection(id) && setDraft({ ...draft, section: id })}
          />
        ) : (
          <Tag>{sectionLabel(candidate.section)}</Tag>
        )}
      </Td>
      <Td valign="top" align="right">
        <span className="mono">{evidenceOf(candidate)}</span>
      </Td>
      <Td valign="top">
        <SourceCell candidate={candidate} />
      </Td>
      <Td valign="top" className="whitespace-nowrap">
        <ConfidenceBars value={candidate.confidence} />
      </Td>
      <Td valign="top">
        {candidate.canDecide && candidate.scopes.length ? (
          <div className="flex flex-col gap-1">
            <Select
              aria-label={`Promote to: ${scope ? scopeLabel(scope, families, titleOf) : 'choose a scope'}`}
              className="w-44"
              options={candidate.scopes.map((key) => ({
                id: key,
                label: scopeLabel(key, families, titleOf),
              }))}
              value={scope}
              onChange={(key) => {
                const next = candidate.scopes.find((k) => k === key)
                if (next) onScope(next)
              }}
            />
            {candidate.targetScope && candidate.targetScope !== scope ? (
              <span className="text-xs text-muted">
                target: {scopeLabel(candidate.targetScope, families, titleOf)}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-muted">
            {candidate.targetScope ? 'target' : 'suggested'}:{' '}
            {suggestedLabel(candidate, families, titleOf)}
          </span>
        )}
      </Td>
      <Td valign="top" align="right">
        {candidate.canDecide ? (
          <div className="flex items-center justify-end gap-1">
            {draft ? (
              <>
                <Button variant="tertiary" size="sm" onPress={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  isPending={edit.isPending}
                  isDisabled={!draft.rule.trim()}
                  onPress={saveEdit}
                >
                  Save
                </Button>
              </>
            ) : (
              <>
                <Tooltip
                  content={
                    candidate.status === 'accepted'
                      ? 'Confirm in the chosen scope'
                      : 'Accept into the chosen scope'
                  }
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    isIconOnly
                    aria-label={`Accept: ${candidate.rule}`}
                    isDisabled={pending || !scope}
                    onPress={() =>
                      scope &&
                      accept.mutate(
                        { id: candidate.id, input: { scope } },
                        {
                          onSuccess: () => notify.success('Rule accepted', candidate.rule),
                          onError: failed('Not accepted'),
                        },
                      )
                    }
                  >
                    <Check className="size-3.5" />
                  </Button>
                </Tooltip>
                <Tooltip content="Edit rule">
                  <Button
                    variant="ghost"
                    size="sm"
                    isIconOnly
                    aria-label={`Edit: ${candidate.rule}`}
                    onPress={() => setDraft({ rule: candidate.rule, section: candidate.section })}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                </Tooltip>
                {candidate.status === 'proposed' || isAutoAccepted(candidate) ? (
                  <Tooltip
                    content={
                      isAutoAccepted(candidate) ? 'Reject and remove from the Guide' : 'Reject'
                    }
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      aria-label={`Reject: ${candidate.rule}`}
                      isDisabled={pending}
                      onPress={() =>
                        reject.mutate(candidate.id, {
                          onSuccess: () => notify.success('Rule rejected'),
                          onError: failed('Not rejected'),
                        })
                      }
                    >
                      <X className="size-3.5" />
                    </Button>
                  </Tooltip>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </Td>
    </Tr>
  )
}
