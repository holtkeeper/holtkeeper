import type { KnowledgeEntry } from '@holtkeeper/api'
import { BookOpen, Plus } from 'lucide-react'
import { useState } from 'react'

import { useKnowledge } from '../../api/queries.ts'
import { entriesOfGroup } from '../../lib/knowledge.ts'
import { type ScopeFocus, scopeOfFocus } from '../../lib/scope.ts'
import { Button, EmptyState, ErrorState, Panel, Placeholder } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { KnowledgeDialog } from './KnowledgeDialog.tsx'
import { KnowledgeList } from './KnowledgeList.tsx'

/**
 * Knowledge for one repository (every entry covering it) or group (entries naming it), with
 * proposals first. New entries start scoped to the focus.
 */
export function ScopedKnowledge({
  focus,
  groups,
}: {
  focus: ScopeFocus
  groups: readonly string[]
}) {
  const { can } = useSession()
  const knowledge = useKnowledge(focus.kind === 'repo' ? { repo: focus.repo } : {})
  const [editing, setEditing] = useState<KnowledgeEntry | 'new' | null>(null)
  const writable = can('knowledge:write')

  const all = knowledge.data?.entries ?? []
  const scoped = focus.kind === 'group' ? entriesOfGroup(all, focus.group) : all
  const live = scoped.filter((entry) => entry.status === 'proposed' || entry.status === 'accepted')
  const proposals = live.filter((entry) => entry.status === 'proposed')
  const accepted = live.filter((entry) => entry.status === 'accepted')

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Knowledge"
        description={
          focus.kind === 'repo'
            ? 'Every accepted entry covering this repository goes into agent tasks here.'
            : 'Entries scoped to this group; agents read them for every repository in it.'
        }
        actions={
          writable ? (
            <Button variant="secondary" size="sm" onPress={() => setEditing('new')}>
              <Plus className="size-3.5" />
              New entry
            </Button>
          ) : null
        }
      >
        {knowledge.isPending ? (
          <Placeholder className="h-24" />
        ) : knowledge.isError ? (
          <ErrorState error={knowledge.error} />
        ) : live.length === 0 ? (
          <EmptyState
            icon={<BookOpen />}
            title="No knowledge yet"
            description="Write down conventions agents should follow here, or wait for their proposals."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {proposals.length ? (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Waiting for review</h3>
                <KnowledgeList entries={proposals} writable={writable} onEdit={setEditing} />
              </section>
            ) : null}
            {accepted.length ? (
              <section className="flex flex-col gap-2">
                {proposals.length ? <h3 className="text-sm font-medium">Accepted</h3> : null}
                <KnowledgeList entries={accepted} writable={writable} onEdit={setEditing} />
              </section>
            ) : null}
          </div>
        )}
      </Panel>
      {editing ? (
        <KnowledgeDialog
          key={editing === 'new' ? 'new' : editing.id}
          {...(editing === 'new' ? { initialScope: scopeOfFocus(focus) } : { entry: editing })}
          groups={groups}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  )
}
