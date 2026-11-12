import { ShieldX } from 'lucide-react'
import { use } from 'react'

import { missingOf } from '../../api/client.ts'
import { actionLabels, roleLabel, summarizeGrants } from '../../lib/access.ts'
import { type Missing, accessRequest, forbiddenTitle, relatedActions } from '../../lib/forbidden.ts'
import { Avatar } from '../../ui/Avatar.tsx'
import { LinkButton } from '../../ui/Button.tsx'
import { KeyValue } from '../../ui/KeyValue.tsx'
import { CopyButton } from '../../ui/Misc.tsx'
import { SessionContext } from './session.ts'

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * The "no access" card shown inside the shell: which permission is missing and on what (from the
 * 403 body in `error`, or `missing`), what the viewer's grants allow, who is signed in, and a
 * request to copy for an admin. Without details it says no grant allows the page.
 */
export function Forbidden({ error, missing }: { error?: unknown; missing?: Missing }) {
  const session = use(SessionContext)
  const what = missing ?? missingOf(error)
  const principal = session?.principal
  const related = principal && what ? relatedActions(principal.grants, what.action) : []
  return (
    <div className="grid w-full place-items-center px-4 py-10">
      <section
        aria-labelledby="forbidden-title"
        className="w-full max-w-[560px] rounded-[10px] border border-line bg-panel"
      >
        <div className="flex gap-3 p-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-danger-soft text-danger-soft-foreground">
            <ShieldX className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 id="forbidden-title" className="text-[14px] font-semibold">
              {forbiddenTitle(what)}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {what ? (
                <>
                  This needs permission to{' '}
                  <b className="font-medium text-foreground">{actionLabels[what.action]}</b>
                  {what.target ? (
                    <>
                      {' '}
                      on <span className="mono text-foreground">{what.target}</span>
                    </>
                  ) : null}
                  . An admin can add it to your grants.
                </>
              ) : (
                'None of your grants allow this page.'
              )}
            </p>
          </div>
        </div>
        {principal ? (
          <KeyValue
            className="border-t border-line px-4 py-3"
            rows={[
              {
                label: 'Missing',
                value: what ? (
                  <>
                    {capitalize(actionLabels[what.action])}
                    <span className="mono text-[11px] text-dim">{what.action}</span>
                  </>
                ) : null,
              },
              {
                label: 'On',
                value: what?.target ? <span className="mono">{what.target}</span> : null,
              },
              {
                label: 'You have',
                value: (
                  <span className="min-w-0">
                    {roleLabel(principal.grants)} · {summarizeGrants(principal.grants)}
                    {related.length ? (
                      <span className="text-muted">
                        {' '}
                        · can {related.map((action) => actionLabels[action]).join(', ')} somewhere
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                label: 'Signed in as',
                value: (
                  <>
                    <Avatar src={principal.avatarUrl} name={principal.name} size="xs" />
                    {principal.name}
                    <span className="text-dim">via {principal.provider}</span>
                  </>
                ),
              },
            ]}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          {principal ? (
            <CopyButton
              text={() =>
                accessRequest({
                  missing: what,
                  name: principal.name,
                  id: principal.email ?? principal.id,
                  page: window.location.href,
                })
              }
            >
              Copy request
            </CopyButton>
          ) : null}
          <span className="flex-1" />
          <LinkButton to="/" variant="ghost" size="sm">
            Go to Home
          </LinkButton>
        </div>
      </section>
    </div>
  )
}
