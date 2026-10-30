import type { KnowledgeEntry, KnowledgeStatus } from '@holtkeeper/api'
import { BookOpen, Plus } from 'lucide-react'
import { useState } from 'react'

import { useKnowledge, useRepos } from '../../api/queries.ts'
import { countByStatus, knowledgeKinds, knowledgeStatuses } from '../../lib/knowledge.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  LinkButton,
  MultiToggle,
  Page,
  Placeholder,
  SearchInput,
  Segmented,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { KnowledgeDialog } from './KnowledgeDialog.tsx'
import { KnowledgeList } from './KnowledgeList.tsx'

/** Team knowledge agents read: proposals to review, accepted entries, and the archive. */
export function KnowledgePage() {
  const { can } = useSession()
  const knowledge = useKnowledge({})
  const repos = useRepos(can('repos:read'))
  const [status, setStatus] = useState<KnowledgeStatus>('proposed')
  const [kinds, setKinds] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<KnowledgeEntry | 'new' | null>(null)
  const writable = can('knowledge:write')
  const groups = [...new Set((repos.data?.repos ?? []).flatMap((r) => r.groups))].toSorted()

  const all = knowledge.data?.entries ?? []
  const counts = countByStatus(all)
  const needle = query.trim().toLowerCase()
  const list = all.filter(
    (entry) =>
      entry.status === status &&
      (!kinds.length || kinds.includes(entry.kind)) &&
      (!needle ||
        entry.title.toLowerCase().includes(needle) ||
        entry.body.toLowerCase().includes(needle) ||
        entry.topics.some((topic) => topic.includes(needle))),
  )

  return (
    <Page
      title="Knowledge"
      icon="knowledge"
      description="Conventions, decisions and lessons agents read before every task"
      actions={
        <>
          <LinkButton to="/settings" search={{ tab: 'knowledge' }} variant="ghost">
            Auto-accept
          </LinkButton>
          {writable ? (
            <Button variant="primary" onPress={() => setEditing('new')}>
              <Plus className="size-4" />
              New entry
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          aria-label="Status"
          options={knowledgeStatuses.map((s) => ({
            id: s.id,
            label: (
              <span className="flex items-center gap-1.5">
                {s.label}
                {counts[s.id] ? <span className="text-xs text-muted">{counts[s.id]}</span> : null}
              </span>
            ),
          }))}
          value={status}
          onChange={setStatus}
        />
        <MultiToggle
          aria-label="Kinds"
          options={knowledgeKinds.map((k) => ({ id: k.id, label: k.label }))}
          value={kinds}
          onChange={setKinds}
        />
        <SearchInput
          aria-label="Filter entries"
          placeholder="Filter by text or topic"
          value={query}
          onChange={setQuery}
          className="w-64"
        />
      </div>
      {knowledge.isPending ? (
        <div className="flex flex-col gap-3">
          <Placeholder className="h-24" />
          <Placeholder className="h-24" />
        </div>
      ) : knowledge.isError ? (
        <ErrorState error={knowledge.error} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title={
            needle || kinds.length
              ? 'Nothing matches'
              : status === 'proposed'
                ? 'No proposals to review'
                : `No ${status} entries`
          }
          description={
            status === 'proposed'
              ? 'Agents propose what they learn while working; proposals wait here until accepted.'
              : undefined
          }
        />
      ) : (
        <KnowledgeList entries={list} writable={writable} onEdit={setEditing} />
      )}
      {editing ? (
        <KnowledgeDialog
          key={editing === 'new' ? 'new' : editing.id}
          {...(editing === 'new' ? {} : { entry: editing })}
          groups={groups}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Page>
  )
}
