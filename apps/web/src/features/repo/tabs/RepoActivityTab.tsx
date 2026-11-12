import type { RepoRef } from '@holtkeeper/api'
import { ArrowRight } from 'lucide-react'

import { useHistory } from '../../../api/queries.ts'
import { repoKey } from '../../../lib/repo.ts'
import { LinkButton } from '../../../ui/index.ts'
import { AuditEventList } from '../../audit-log/AuditEventList.tsx'

/**
 * The hub's Activity tab: audit events about the repository, newest first, as Settings › Audit
 * log shows them to the reader (global `audit:read` sees every event, `repos:read` the events of
 * its repositories).
 */
export function RepoActivityTab({ repo }: { repo: RepoRef }) {
  const history = useHistory({ repos: repoKey(repo) })
  return (
    <div className="flex flex-col gap-3">
      <div>
        <LinkButton
          to="/settings/$section"
          params={{ section: 'audit' }}
          search={{ repo: repoKey(repo) }}
          variant="ghost"
          size="sm"
        >
          Open in Settings › Audit log
          <ArrowRight className="size-3.5" />
        </LinkButton>
      </div>
      <AuditEventList history={history} empty="Nothing happened in this repository yet" framed />
    </div>
  )
}
