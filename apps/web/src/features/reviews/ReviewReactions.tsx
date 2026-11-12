import type { RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'

import { useReactionTotals } from '../../api/queries.ts'
import { helpfulShare, reactionSum } from '../../lib/learnings.ts'
import { repoKey } from '../../lib/repo.ts'
import { Legend, SegmentBar, Tag } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

/**
 * 👍/👎 on Holtkeeper's review comments per finding category (`GET /api/learnings/reactions`),
 * for one repository or, with a global `knowledge:read` grant, every one. Renders nothing
 * without reactions or rights.
 */
export function ReviewReactions({ repo }: { repo?: RepoRef }) {
  const { can, canGlobal } = useSession()
  const allowed = repo ? can('knowledge:read') : canGlobal('knowledge:read')
  const totals = useReactionTotals(repo, allowed)
  const rows = totals.data?.totals ?? []
  if (!allowed || !rows.length) return null
  const sum = reactionSum(rows)
  const share = helpfulShare(sum)
  return (
    <section
      aria-label="Reactions by finding category"
      className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="text-[13px] font-semibold">
          Reactions by finding category
          <small className="ml-2 text-xs font-normal text-muted">
            👍 and 👎 on Holtkeeper&apos;s review comments
          </small>
        </h2>
        {share !== undefined ? (
          <Tag tone={share >= 70 ? 'success' : share >= 40 ? 'warning' : 'danger'}>
            {share}% helpful
          </Tag>
        ) : null}
        <span className="flex-1" />
        <Legend
          items={[
            { label: 'helpful', tone: 'info' },
            { label: 'not helpful', tone: 'warning' },
          ]}
        />
        <Link
          to="/knowledge/learnings"
          search={repo ? { space: `repo:${repoKey(repo)}` } : {}}
          className="text-xs hover:underline"
        >
          Learning candidates
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => {
          const rowShare = helpfulShare(row)
          return (
            <div key={row.category} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="mono truncate text-xs">{row.category}</span>
                <span className="flex-1" />
                <span className="mono text-xs text-muted">
                  {rowShare === undefined ? '—' : `${rowShare}% helpful`}
                </span>
              </div>
              <SegmentBar
                segments={[
                  { value: row.up, tone: 'info', label: 'helpful' },
                  { value: row.down, tone: 'warning', label: 'not helpful' },
                ]}
              />
              <span className="text-[11.5px] text-muted">
                <span className="mono">{row.up}</span> helpful ·{' '}
                <span className="mono">{row.down}</span> not helpful ·{' '}
                <span className="mono">{row.comments}</span> comments
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
