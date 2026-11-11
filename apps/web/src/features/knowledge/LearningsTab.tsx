import type {
  Family,
  GuideScopeKey,
  GuideSectionName,
  LearningCandidateView,
  LearningSource,
  PersonView,
  RepoSummary,
} from '@holtkeeper/api'
import { Check, ExternalLink, GraduationCap, Pencil, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useLearningMutations, useLearnings, useReactionTotals } from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import {
  type Space,
  candidatesInSpace,
  guideSections,
  reposOfSpace,
  scopeLabel,
  sectionLabel,
} from '../../lib/guide.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  Placeholder,
  SegmentBar,
  Select,
  Tag,
  TextField,
  notify,
} from '../../ui/index.ts'
import { Byline } from './parts.tsx'

const failed = (title: string) => (error: Error) => notify.error(title, messageOf(error))

const isSection = (value: string): value is GuideSectionName =>
  guideSections.some((s) => s.id === value)

/** The scope a candidate's suggestion points at among those the caller may pick, else the first. */
const defaultScope = (candidate: LearningCandidateView): GuideScopeKey | undefined =>
  candidate.scopes.find((key) => key.startsWith(`${candidate.suggestedScope}:`)) ??
  candidate.scopes[0]

/**
 * Rules learned from replies to review comments: candidates to accept into a scope, edit or
 * reject, the accepted ones with where they came from, and 👍/👎 on review comments.
 */
export function LearningsTab({
  space,
  repos,
  families,
}: {
  space: Space
  repos: readonly RepoSummary[]
  families: readonly Family[]
}) {
  const learnings = useLearnings(space.kind === 'repo' ? { repo: space.repo } : {})
  const [showRejected, setShowRejected] = useState(false)

  if (learnings.isPending) return <Placeholder className="h-40" />
  if (learnings.isError) return <ErrorState error={learnings.error} />

  const { people } = learnings.data
  const all = candidatesInSpace(learnings.data.candidates, reposOfSpace(space, repos, families))
  const proposed = all.filter((c) => c.status === 'proposed')
  const accepted = all.filter((c) => c.status === 'accepted')
  const rejected = all.filter((c) => c.status === 'rejected')

  return (
    <div className="flex flex-col gap-5">
      <Group label="Candidates" count={proposed.length}>
        {proposed.length ? (
          proposed.map((candidate) => (
            <CandidateRow
              key={candidate.id}
              candidate={candidate}
              families={families}
              people={people}
            />
          ))
        ) : (
          <EmptyState
            icon={<GraduationCap />}
            title="No candidates"
            description="When someone answers a review comment with feedback, the rule it teaches waits here for a person."
          />
        )}
      </Group>
      <Group label="Accepted" count={accepted.length}>
        {accepted.length ? (
          accepted.map((candidate) => (
            <CandidateRow
              key={candidate.id}
              candidate={candidate}
              families={families}
              people={people}
            />
          ))
        ) : (
          <p className="text-sm text-muted">Nothing accepted yet.</p>
        )}
      </Group>
      {rejected.length ? (
        <div className="flex flex-col gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onPress={() => setShowRejected((value) => !value)}
          >
            {showRejected ? 'Hide' : 'Show'} {rejected.length} rejected
          </Button>
          {showRejected
            ? rejected.map((candidate) => (
                <CandidateRow
                  key={candidate.id}
                  candidate={candidate}
                  families={families}
                  people={people}
                />
              ))
            : null}
        </div>
      ) : null}
      {space.kind === 'all' || space.kind === 'repo' ? <Reactions space={space} /> : null}
    </div>
  )
}

function Group({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
        <span className="mono font-normal text-dim">{count}</span>
      </h2>
      {children}
    </section>
  )
}

function SourceLink({ source }: { source: LearningSource }) {
  const label = `!${source.mergeRequest} @${source.author}`
  return source.url ? (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className="mono inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
    >
      {label}
      <ExternalLink className="size-3" />
    </a>
  ) : (
    <span className="mono text-xs text-muted">{label}</span>
  )
}

function CandidateRow({
  candidate,
  families,
  people,
}: {
  candidate: LearningCandidateView
  families: readonly Family[]
  people: Readonly<Record<string, PersonView>>
}) {
  const { accept, edit, reject } = useLearningMutations()
  const [scope, setScope] = useState<GuideScopeKey | undefined>(
    candidate.acceptedScope ?? defaultScope(candidate),
  )
  const [draft, setDraft] = useState<{ rule: string; section: GuideSectionName } | null>(null)
  const pending = accept.isPending || edit.isPending || reject.isPending

  const saveEdit = () =>
    draft &&
    edit.mutate(
      { id: candidate.id, input: { rule: draft.rule.trim(), section: draft.section } },
      { onSuccess: () => setDraft(null), onError: failed('Not saved') },
    )

  return (
    <article className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3">
      {draft ? (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <TextField
            aria-label="Rule"
            value={draft.rule}
            onChange={(rule) => setDraft({ ...draft, rule })}
          />
          <Select
            aria-label="Section"
            options={guideSections.map((s) => ({ id: s.id, label: s.label }))}
            value={draft.section}
            onChange={(id) => isSection(id) && setDraft({ ...draft, section: id })}
          />
        </div>
      ) : (
        <p className="text-[13px]">{candidate.rule}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag>{sectionLabel(candidate.section)}</Tag>
        {candidate.status === 'accepted' && candidate.acceptedScope ? (
          <Tag tone="success" dot>
            {scopeLabel(candidate.acceptedScope, families)}
          </Tag>
        ) : (
          <Tag tone="info">suggested: {candidate.suggestedScope}</Tag>
        )}
        {candidate.status === 'rejected' ? (
          <Tag tone="danger" dot>
            rejected
          </Tag>
        ) : null}
        <span className="mono text-xs text-muted">{candidate.repo}</span>
        {candidate.sources.map((source) => (
          <SourceLink key={source.noteId} source={source} />
        ))}
        {candidate.proposal ? (
          <Tag>proposed over MCP</Tag>
        ) : (
          <span className="mono ml-auto text-xs text-dim">
            {candidate.model} · {formatUsd(candidate.costUsd)}
          </span>
        )}
      </div>
      {candidate.proposal ? (
        <div className="flex flex-col gap-1">
          <Byline
            verb="proposed"
            id={candidate.proposal.by}
            at={candidate.createdAt}
            people={people}
          />
          <p className="text-xs text-muted">{candidate.proposal.reason}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Byline
          verb={candidate.status === 'rejected' ? 'rejected' : 'accepted'}
          id={candidate.status === 'proposed' ? undefined : candidate.decidedBy}
          at={candidate.decidedAt}
          people={people}
        />
        {candidate.canDecide ? (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
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
                {candidate.status !== 'accepted' && candidate.scopes.length ? (
                  <>
                    <Select
                      aria-label="Scope"
                      className="w-48"
                      options={candidate.scopes.map((key) => ({
                        id: key,
                        label: scopeLabel(key, families),
                      }))}
                      value={scope}
                      onChange={(key) => setScope(candidate.scopes.find((k) => k === key))}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
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
                      Accept
                    </Button>
                  </>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  aria-label="Edit rule"
                  onPress={() => setDraft({ rule: candidate.rule, section: candidate.section })}
                >
                  <Pencil className="size-3.5" />
                </Button>
                {candidate.status !== 'rejected' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    isDisabled={pending}
                    onPress={() =>
                      reject.mutate(candidate.id, {
                        onSuccess: () => notify.success('Rule rejected'),
                        onError: failed('Not rejected'),
                      })
                    }
                  >
                    <X className="size-3.5" />
                    {candidate.status === 'accepted' ? 'Remove' : 'Reject'}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </article>
  )
}

/** 👍/👎 on Holtkeeper's review comments per finding category, for one repository or all of them. */
function Reactions({ space }: { space: Space }) {
  const totals = useReactionTotals(space.kind === 'repo' ? space.repo : undefined)
  const rows = totals.data?.totals ?? []
  if (!rows.length) return null
  return (
    <Group label="Reactions on review comments" count={rows.length}>
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-panel">
        {rows.map((row) => (
          <li
            key={row.category}
            className="grid grid-cols-[8rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2"
          >
            <span className="mono truncate text-xs">{row.category}</span>
            <SegmentBar
              segments={[
                { value: row.up, tone: 'success', label: 'thumbs up' },
                { value: row.down, tone: 'danger', label: 'thumbs down' },
              ]}
            />
            <span className="mono text-xs text-muted">
              👍 {row.up} · 👎 {row.down} · {row.comments} comments
            </span>
          </li>
        ))}
      </ul>
    </Group>
  )
}
