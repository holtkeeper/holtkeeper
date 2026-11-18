import type { ConfigEntryView } from '@holtkeeper/api'
import { Link, useNavigate } from '@tanstack/react-router'
import { Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { usePutTeam, useRepos, useTeams, useTeamTitles } from '../../api/queries.ts'
import { plural } from '../../lib/format.ts'
import { type TeamRow, healthCountsText, teamEditLevel, teamRows } from '../../lib/repos.ts'
import { type SortState, sortRows } from '../../lib/table-sort.ts'
import { teamMatchesQuery } from '../../lib/team-titles.ts'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  type FleetColumn,
  FleetTable,
  notify,
  Page,
  Placeholder,
  Tag,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { TeamDialog } from './TeamDialog.tsx'

type TeamSortKey = 'team' | 'repos' | 'failing'

const PATTERNS_SHOWN = 3

function Patterns({ label, patterns }: { label: string; patterns: readonly string[] }) {
  if (!patterns.length) return null
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="text-[11px] text-dim">{label}</span>
      {patterns.slice(0, PATTERNS_SHOWN).map((pattern) => (
        <Tag key={pattern} mono>
          {pattern}
        </Tag>
      ))}
      {patterns.length > PATTERNS_SHOWN ? (
        <span className="text-xs text-muted">+{patterns.length - PATTERNS_SHOWN}</span>
      ) : null}
    </span>
  )
}

/**
 * Repos › Teams: every team the viewer can see with its patterns, members and the fleet
 * repositories it owns (counted here from its patterns over the repository list). Global
 * `settings:write` creates, edits and deletes teams; a team's maintainers edit its title and
 * members. Without the config (no `settings:read`), teams come from the repositories' owners.
 */
export function TeamsPage() {
  const { can, principal } = useSession()
  const repos = useRepos()
  const config = useTeams(can('settings:read'))
  const navigate = useNavigate()
  const titleOf = useTeamTitles()
  const { view, setView, homeTeams } = useScope()
  const put = usePutTeam()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortState<TeamSortKey>>(null)
  const [editing, setEditing] = useState<ConfigEntryView<'team'> | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ConfigEntryView<'team'> | null>(null)
  const entries = config.data?.entries ?? []
  const all = repos.data?.repos ?? []
  const needle = query.trim().toLowerCase()
  const levelOf = (id: string | undefined) => teamEditLevel(principal.grants, id)
  const rows = sortRows(
    teamRows(all, entries, titleOf).filter(
      (row) =>
        !needle ||
        teamMatchesQuery(row.id, titleOf, needle) ||
        [...(row.definition?.owns ?? []), ...(row.definition?.members ?? []).map((m) => m.id)].some(
          (text) => text.toLowerCase().includes(needle),
        ),
    ),
    sort,
    (row, key) =>
      key === 'team'
        ? titleOf(row.id).toLowerCase()
        : key === 'repos'
          ? row.repos.length
          : -row.counts.failing,
  )
  const entryOf = (id: string) => entries.find((entry) => entry.id === id)
  const canCreate = levelOf(undefined) === 'full'

  const columns: readonly FleetColumn<TeamRow, TeamSortKey>[] = [
    {
      id: 'team',
      header: 'Team',
      sortKey: 'team',
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <Link
            to="/repos/teams/$teamId"
            params={{ teamId: row.id }}
            className="font-medium hover:underline"
          >
            {titleOf(row.id)}
          </Link>
          <span className="mono text-[11px] text-dim">{row.id}</span>
        </div>
      ),
    },
    {
      id: 'patterns',
      header: 'Patterns',
      cell: (row) =>
        row.definition ? (
          <div className="flex flex-col gap-1">
            <Patterns label="owns" patterns={row.definition.owns} />
            <Patterns label="exclude" patterns={row.definition.exclude} />
            <Patterns label="consumes" patterns={row.definition.consumes} />
          </div>
        ) : (
          <span className="text-xs text-dim">—</span>
        ),
    },
    {
      id: 'members',
      header: 'Members',
      cell: (row) => {
        const members = row.definition?.members ?? []
        if (!members.length) return <span className="text-xs text-dim">—</span>
        return (
          <span className="flex flex-wrap gap-1">
            {members.slice(0, 4).map((member) => (
              <Tag key={member.id} mono>
                {member.id}
                {member.role === 'maintainer' ? ' · maintainer' : ''}
              </Tag>
            ))}
            {members.length > 4 ? (
              <span className="text-xs text-muted">+{members.length - 4}</span>
            ) : null}
          </span>
        )
      },
    },
    {
      id: 'repos',
      header: 'Repositories',
      sortKey: 'repos',
      align: 'right',
      cell: (row) => (
        <div className="flex flex-col items-end gap-0.5">
          <span className="tabular">{row.repos.length}</span>
          {row.consumed ? (
            <span className="text-[11px] text-dim">+{row.consumed} consumed</span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'health',
      header: 'Health',
      sortKey: 'failing',
      cell: (row) => (
        <span className="text-xs text-muted">
          {healthCountsText(row.counts).join(' · ') || '—'}
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (row) => {
        const entry = entryOf(row.id)
        const level = levelOf(row.id)
        if (!entry || level === 'none') return null
        return (
          <span className="inline-flex">
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={`Edit ${titleOf(row.id)}`}
              onPress={() => setEditing(entry)}
            >
              <Pencil className="size-3.5" />
            </Button>
            {level === 'full' ? (
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={`Delete ${titleOf(row.id)}`}
                onPress={() => setDeleting(entry)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            ) : null}
          </span>
        )
      },
    },
  ]

  return (
    <Page
      crumbs={[{ label: 'Teams' }]}
      title="Repos"
      search={{
        value: query,
        onChange: setQuery,
        'aria-label': 'Filter teams',
        placeholder: 'Filter by name, key, pattern or member',
      }}
      {...(canCreate
        ? { primary: { label: 'New team', icon: Plus, onPress: () => setEditing('new') } }
        : {})}
    >
      {repos.isPending ? (
        <Placeholder className="h-48" />
      ) : repos.isError ? (
        <ErrorState error={repos.error} />
      ) : (
        <FleetTable<TeamRow, TeamSortKey>
          label="Teams"
          rows={rows}
          rowKey={(row) => row.id}
          columns={columns}
          sort={sort}
          onSort={setSort}
          scope={{ value: view, onChange: setView, homeTeams }}
          noun={{ one: 'team' }}
          strip={(shown) => {
            const owned = new Set(
              shown.flatMap((row) => row.repos.map((r) => `${r.repo.forge}:${r.repo.path}`)),
            )
            const unowned = all.filter((r) => r.teams.length === 0).length
            return [
              { value: shown.length, label: shown.length === 1 ? 'team' : 'teams' },
              { value: owned.size, label: owned.size === 1 ? 'repository' : 'repositories' },
              {
                value: shown.filter((row) => row.counts.failing > 0).length,
                label: 'with failing repositories',
                tone: 'danger',
              },
              ...(unowned
                ? [
                    {
                      value: unowned,
                      label: 'owned by no team',
                      tone: 'warning' as const,
                      end: true,
                    },
                  ]
                : []),
            ]
          }}
          onOpen={(row) =>
            void navigate({ to: '/repos/teams/$teamId', params: { teamId: row.id } })
          }
          empty={
            <EmptyState
              icon={<Users />}
              title={needle ? 'No team matches' : 'No teams yet'}
              description={
                canCreate
                  ? 'Create a team and give it the folders it owns, e.g. acme/round/**.'
                  : 'Teams appear once an admin creates them.'
              }
            />
          }
        />
      )}
      {editing ? (
        <TeamDialog
          key={editing === 'new' ? 'new' : editing.id}
          {...(editing === 'new' ? {} : { entry: editing })}
          level={editing === 'new' ? 'full' : levelOf(editing.id) === 'full' ? 'full' : 'members'}
          repos={all}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete team ${deleting ? titleOf(deleting.id) : ''}?`}
        isPending={put.isPending}
        onConfirm={() =>
          deleting &&
          put.mutate(
            { id: deleting.id, data: null },
            {
              onSuccess: () => {
                notify.success('Team deleted', titleOf(deleting.id))
                setDeleting(null)
              },
              onError: (error) => notify.error('Team not deleted', messageOf(error)),
            },
          )
        }
      >
        {deleting
          ? `${plural(teamRows(all, [deleting], titleOf)[0]?.repos.length ?? 0, 'repository', 'repositories')} lose this owner. Grants, settings and rules naming the team stop matching.`
          : null}
      </ConfirmDialog>
    </Page>
  )
}
