import { useNavigate, useSearch } from '@tanstack/react-router'
import { MessagesSquare } from 'lucide-react'
import { useDeferredValue, useState } from 'react'

import { useChatThreads } from '../../api/queries.ts'
import { scopeThreads } from '../../lib/chat.ts'
import { EmptyState } from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { ThreadList } from './ThreadList.tsx'
import { ThreadPane } from './ThreadPane.tsx'

/**
 * Team chat: threads the team shares with Holtkeeper, scoped like every list by the scope switch,
 * other teams' threads folded under the list. The open thread lives in the `thread` search
 * parameter, so links point at one thread.
 */
export function ChatPage() {
  const search = useSearch({ from: '/app/chat' })
  const navigate = useNavigate({ from: '/chat' })
  const [archived, setArchived] = useState(false)
  const [query, setQuery] = useState('')
  const q = useDeferredValue(query)
  const threads = useChatThreads(archived, q)
  const { view, setView, homeGroups } = useScope()
  const scoped = threads.data ? scopeThreads(threads.data.threads, view, homeGroups) : undefined
  const shown = scoped?.shown ?? []
  const current = search.thread ?? shown[0]?.id
  const select = (id: string) => void navigate({ search: { thread: id }, replace: true })

  return (
    <div className="flex h-[calc(100dvh-18px)] min-h-0 flex-col md:flex-row">
      <ThreadList
        threads={shown}
        others={scoped?.others ?? []}
        otherTeams={scoped?.teams ?? []}
        counts={scoped?.counts}
        view={view}
        onView={setView}
        query={query}
        onQuery={setQuery}
        archived={archived}
        onArchived={setArchived}
        archivedCount={threads.data?.archivedCount ?? 0}
        groups={threads.data?.groups ?? []}
        selected={current}
        onSelect={select}
        isPending={threads.isPending}
        error={threads.error}
      />
      {current ? (
        <ThreadPane key={current} threadId={current} commands={threads.data?.commands ?? []} />
      ) : (
        <div className="grid flex-1 place-items-center p-6">
          <EmptyState
            icon={<MessagesSquare aria-hidden />}
            title="No thread open"
            description="Start a thread for the whole team, a group or one repository. Mention @holtkeeper to ask the agent; / runs commands in repository and group threads."
          />
        </div>
      )}
    </div>
  )
}
