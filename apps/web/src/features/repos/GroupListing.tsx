import type {
  ConfigEntryView,
  GroupDocumentData,
  GroupListingView,
  RepoSummary,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ChevronRight, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useGroupListing, useListGroup, usePutGroup } from '../../api/queries.ts'
import { formatDateTime, formatDuration, formatRelative, plural } from '../../lib/format.ts'
import { dotToTagTone, healthLabels, healthTones } from '../../lib/home.ts'
import { repoKey, repoSplat, splitRepoPath } from '../../lib/repo.ts'
import {
  type Membership,
  type MembershipState,
  groupMembership,
  isExactPattern,
  membershipChangeText,
  membershipLabels,
  patternChanges,
  updatesText,
} from '../../lib/repos.ts'
import {
  Button,
  Dot,
  ErrorState,
  KeyValue,
  Notice,
  Panel,
  Placeholder,
  SearchInput,
  Segmented,
  Table,
  Tag,
  Td,
  Th,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { ListingAttempts } from './Attempts.tsx'

type Patterns = Pick<GroupDocumentData, 'include' | 'exclude'>

/**
 * The group's Membership tab: its include and exclude patterns (editable with global
 * `settings:write`, unsaved changes previewed on the last listing), the listing on the forge with
 * when it runs next, and every repository the patterns resolve to, excluded ones included.
 */
export function GroupMembership({
  entry,
  members,
}: {
  entry: ConfigEntryView<'group'>
  /** The group's members the viewer can see, for health and updates. */
  members: readonly RepoSummary[]
}) {
  const listing = useGroupListing(entry.id)
  const [draft, setDraft] = useState<Patterns>({
    include: entry.data.include,
    exclude: entry.data.exclude,
  })
  const matched = listing.data
    ? [...(listing.data.matched ?? []), ...listing.data.repos]
    : members.map((summary) => summary.repo)
  const membership = groupMembership(entry.data.forge, matched, entry.data, draft)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <PatternsPanel
          key={entry.version ?? 0}
          entry={entry}
          draft={draft}
          onDraft={setDraft}
          membership={membership}
        />
        {listing.isPending ? (
          <Placeholder className="h-48" />
        ) : listing.isError ? (
          <ErrorState error={listing.error} />
        ) : (
          <ListingPanel group={entry.id} listing={listing.data} membership={membership} />
        )}
      </div>
      <ResolvedPanel
        group={entry.id}
        membership={membership}
        members={members}
        preview={patternChanges(entry.data, draft) > 0}
      />
    </div>
  )
}

function PatternsPanel({
  entry,
  draft,
  onDraft,
  membership,
}: {
  entry: ConfigEntryView<'group'>
  draft: Patterns
  onDraft: (next: Patterns) => void
  membership: Membership
}) {
  const { canGlobal } = useSession()
  const put = usePutGroup()
  const writable = canGlobal('settings:write')
  const changes = patternChanges(entry.data, draft)
  const save = () =>
    put.mutate(
      { id: entry.id, data: { forge: entry.data.forge, ...draft } },
      {
        onSuccess: () => notify.success('Patterns saved', entry.id),
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )

  return (
    <Panel
      title="Patterns"
      description={
        <>
          Path globs on <span className="mono">{entry.data.forge}</span>. A repository is a member
          when an include pattern matches it and no exclude pattern does; exact paths list it before
          its first analysis.
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <PatternList
            label="Include"
            patterns={draft.include}
            saved={entry.data.include}
            count={(pattern) => {
              const counts = membership.counts.include[pattern]
              if (!counts) return ''
              return [
                plural(counts.members, 'member'),
                ...(counts.excluded ? [`${counts.excluded} excluded`] : []),
              ].join(' · ')
            }}
            placeholder="team/* or team/app"
            {...(writable
              ? {
                  onChange: (include: string[]) => onDraft({ ...draft, include }),
                }
              : {})}
          />
          <PatternList
            label="Exclude"
            patterns={draft.exclude}
            saved={entry.data.exclude}
            count={(pattern) => `keeps out ${membership.counts.exclude[pattern] ?? 0}`}
            placeholder="team/legacy-*"
            {...(writable
              ? { onChange: (exclude: string[]) => onDraft({ ...draft, exclude }) }
              : {})}
          />
        </div>
        {writable && changes ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raise px-3 py-2 text-xs"
          >
            <Tag tone="info" dot>
              {plural(changes, 'unsaved change')}
            </Tag>
            <span className="text-muted">
              {membershipChangeText(membership)}, from the last listing
            </span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onPress={() => onDraft({ include: entry.data.include, exclude: entry.data.exclude })}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              size="sm"
              isDisabled={draft.include.length === 0}
              isPending={put.isPending}
              onPress={save}
            >
              Save patterns
            </Button>
          </div>
        ) : null}
      </div>
    </Panel>
  )
}

function PatternList({
  label,
  patterns,
  saved,
  count,
  placeholder,
  onChange,
}: {
  label: string
  patterns: readonly string[]
  saved: readonly string[]
  count: (pattern: string) => string
  placeholder: string
  /** Makes the list editable. */
  onChange?: (patterns: string[]) => void
}) {
  const [adding, setAdding] = useState('')
  const value = adding.trim()
  const add = () => {
    if (!value || !onChange || patterns.includes(value)) return
    onChange([...patterns, value])
    setAdding('')
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">
        {label} <span className="tabular text-dim">{patterns.length}</span>
      </span>
      {patterns.length ? (
        <ul
          aria-label={`${label} patterns`}
          className="flex flex-col divide-y divide-line rounded-lg border border-line"
        >
          {patterns.map((pattern) => {
            const fresh = !saved.includes(pattern)
            return (
              <li key={pattern} className="flex items-center gap-2 px-2.5 py-1.5">
                <span className="mono min-w-0 truncate text-[12.5px]">{pattern}</span>
                <Tag {...(fresh ? { tone: 'info' as const } : {})}>
                  {fresh ? 'new' : isExactPattern(pattern) ? 'exact' : 'glob'}
                </Tag>
                <span className="flex-1" />
                <span className="text-[11px] text-dim">{count(pattern)}</span>
                {onChange ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    isIconOnly
                    aria-label={`Remove ${label.toLowerCase()} pattern ${pattern}`}
                    onPress={() => onChange(patterns.filter((entry) => entry !== pattern))}
                  >
                    <X className="size-3.5" />
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <span className="text-xs text-muted">none</span>
      )}
      {onChange ? (
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
        >
          <input
            aria-label={`Add ${label.toLowerCase()} pattern`}
            placeholder={placeholder}
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            className="mono h-7 min-w-0 flex-1 rounded-[7px] border border-line bg-transparent px-2 text-[12.5px] outline-none focus:border-line-strong"
          />
          <Button variant="secondary" size="sm" type="submit" isDisabled={!value}>
            Add
          </Button>
        </form>
      ) : null}
    </div>
  )
}

function ListingPanel({
  group,
  listing,
  membership,
}: {
  group: string
  listing: GroupListingView
  membership: Membership
}) {
  const { canGlobal } = useSession()
  const list = useListGroup(group)
  const latest = listing.attempts[0]

  return (
    <Panel
      title="Listing on the forge"
      description={`Patterns resolve against ${listing.forge} on a schedule. A failed listing keeps the previous list.`}
      actions={
        <span className="flex items-center gap-2">
          {latest ? (
            <Tag tone={latest.error ? 'danger' : 'success'} dot>
              {latest.error ? 'Failed' : 'Succeeded'}
            </Tag>
          ) : null}
          {canGlobal('settings:write') ? (
            <Button
              variant="secondary"
              size="sm"
              isPending={list.isPending}
              onPress={() =>
                list.mutate(undefined, {
                  onSuccess: (result) =>
                    result.attempts[0]?.error
                      ? notify.error('Listing failed', result.attempts[0].error)
                      : notify.success(`${result.repos.length} repositories found`),
                  onError: (error) => notify.error('Listing failed', messageOf(error)),
                })
              }
            >
              <RefreshCw className="size-3.5" />
              List now
            </Button>
          ) : null}
        </span>
      }
    >
      <div className="flex flex-col gap-4">
        {latest?.error ? (
          <Notice tone="danger" title="The last listing failed">
            {latest.error}
            {listing.listedAt
              ? ` The list from ${formatRelative(listing.listedAt)} stays in use.`
              : ' Exact paths of the patterns stay in use until a listing succeeds.'}
          </Notice>
        ) : null}
        <KeyValue
          rows={[
            {
              label: 'Last listing',
              value: latest ? (
                <>
                  <span title={formatDateTime(latest.at)}>{formatRelative(latest.at)}</span>
                  <span className="text-muted">
                    · {latest.trigger === 'manual' ? 'By hand' : 'Scheduled'} · took
                  </span>
                  <span className="mono">{formatDuration(latest.durationMs)}</span>
                </>
              ) : (
                <span className="text-muted">Never listed</span>
              ),
            },
            {
              label: 'Result',
              value: (
                <>
                  {membership.members + membership.excluded} matched
                  <span className="text-muted">
                    · {membership.excluded} excluded · {plural(membership.members, 'member')}
                  </span>
                </>
              ),
            },
            {
              label: 'Next listing',
              value: listing.nextAt ? (
                <span title={formatDateTime(listing.nextAt)}>{formatRelative(listing.nextAt)}</span>
              ) : (
                <span className="text-muted">Listing is off</span>
              ),
            },
          ]}
        />
        <ListingAttempts attempts={listing.attempts} />
      </div>
    </Panel>
  )
}

type Show = 'all' | MembershipState

function ResolvedPanel({
  group,
  membership,
  members,
  preview,
}: {
  group: string
  membership: Membership
  members: readonly RepoSummary[]
  /** Unsaved patterns are previewed. */
  preview: boolean
}) {
  const [show, setShow] = useState<Show>('all')
  const [query, setQuery] = useState('')
  const summaries = new Map(members.map((summary) => [repoKey(summary.repo), summary]))
  const count = (state: MembershipState) => membership.rows.filter((r) => r.state === state).length
  const options: { id: Show; label: string }[] = [
    { id: 'all', label: `All ${membership.rows.length}` },
    { id: 'member', label: `Members ${count('member')}` },
    { id: 'excluded', label: `Excluded ${count('excluded')}` },
    ...(membership.joins
      ? [{ id: 'joins' as const, label: `Joins on save ${membership.joins}` }]
      : []),
    ...(membership.leaves
      ? [{ id: 'leaves' as const, label: `Leaves on save ${membership.leaves}` }]
      : []),
  ]
  const needle = query.trim().toLowerCase()
  const rows = membership.rows.filter(
    (row) =>
      (show === 'all' || row.state === show) &&
      (!needle || row.repo.path.toLowerCase().includes(needle)),
  )

  return (
    <Panel
      title="Resolved repositories"
      description={preview ? 'Preview of the unsaved patterns, from the last listing.' : undefined}
      actions={
        <span className="flex flex-wrap items-center gap-2">
          <Segmented
            aria-label="Show"
            options={options}
            value={options.some((option) => option.id === show) ? show : 'all'}
            onChange={setShow}
          />
          <SearchInput
            aria-label="Filter resolved repositories"
            placeholder="Filter by path"
            value={query}
            onChange={setQuery}
          />
        </span>
      }
      contentClassName="p-0"
    >
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-muted">
          {membership.rows.length
            ? 'No repository matches'
            : 'The patterns resolve to nothing yet.'}
        </p>
      ) : (
        <Table label="Resolved repositories">
          <thead>
            <tr>
              <Th>Repository</Th>
              <Th>Membership</Th>
              <Th>Matched by</Th>
              <Th>Source</Th>
              <Th>Health</Th>
              <Th>Last analysed</Th>
              <Th>Updates</Th>
              <Th>
                <span className="sr-only">Open</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const summary = summaries.get(repoKey(row.repo))
              const { namespace, name } = splitRepoPath(row.repo.path)
              const state = membershipLabels[row.state]
              const updates = updatesText(summary?.updates)
              const inside = row.state === 'member' || row.state === 'leaves'
              return (
                <tr key={row.repo.path} className={row.state === 'excluded' ? 'opacity-60' : ''}>
                  <Td>
                    {inside ? (
                      <Link
                        to="/repos/$"
                        params={{ _splat: repoSplat(row.repo) }}
                        className="mono hover:underline"
                      >
                        <span className="text-muted">{namespace}</span>
                        {name}
                      </Link>
                    ) : (
                      <span className="mono">
                        <span className="text-muted">{namespace}</span>
                        {name}
                      </span>
                    )}
                    {summary && summary.groups.some((other) => other !== group) ? (
                      <span className="ms-2 text-[11.5px] text-dim">
                        also in {summary.groups.filter((other) => other !== group).join(', ')}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <Tag tone={dotToTagTone(state.tone)} dot>
                      {state.label}
                    </Tag>
                  </Td>
                  <Td>
                    <span className="mono text-[12.5px]">{row.pattern ?? '—'}</span>
                  </Td>
                  <Td>
                    <span className="text-muted">
                      {row.source === 'exact' ? 'Exact path' : 'Listed on the forge'}
                    </span>
                  </Td>
                  <Td>
                    {summary ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Dot tone={healthTones[summary.health]} />
                        {healthLabels[summary.health]}
                      </span>
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-muted">
                      {summary?.lastAnalysedAt ? formatRelative(summary.lastAnalysedAt) : '—'}
                    </span>
                  </Td>
                  <Td>
                    {summary?.updates ? (
                      <Tag tone={dotToTagTone(updates.tone)} dot>
                        {updates.text}
                      </Tag>
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </Td>
                  <Td align="right">
                    {inside ? (
                      <Link
                        to="/repos/$"
                        params={{ _splat: repoSplat(row.repo) }}
                        aria-label={`Open ${row.repo.path}`}
                        className="inline-flex text-muted hover:text-foreground"
                      >
                        <ChevronRight className="size-4" />
                      </Link>
                    ) : null}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      )}
    </Panel>
  )
}
