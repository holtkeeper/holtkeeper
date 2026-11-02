import { useSearch } from '@tanstack/react-router'
import { BadgeCheck, Link2Off } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { messageOf } from '../../api/client.ts'
import { useClaimAccount } from '../../api/queries.ts'
import { providerLabel } from '../../lib/accounts.ts'
import { EmptyState, LinkButton, Page, Placeholder } from '../../ui/index.ts'

/**
 * Opens a link a chat bot sent: links that chat account to the signed-in person, verified, and
 * says so. The token works once, so it is sent exactly once per page view.
 */
export function ClaimPage() {
  const search: { token?: unknown } = useSearch({ strict: false })
  const token = typeof search.token === 'string' ? search.token : ''
  const claim = useClaimAccount()
  const sent = useRef(false)

  useEffect(() => {
    if (!token || sent.current) return
    sent.current = true
    claim.mutate({ token })
  }, [token, claim])

  return (
    <Page title="Link your account">
      <div className="mx-auto w-full max-w-lg">
        {!token ? (
          <EmptyState
            icon={<Link2Off aria-hidden />}
            title="No link here"
            description="Send the bot link in a direct message and open the link it answers with."
          />
        ) : claim.isSuccess ? (
          <EmptyState
            icon={<BadgeCheck aria-hidden className="text-success" />}
            title="Linked"
            description={`Your ${providerLabel(claim.data.provider)} account now acts as you. Commands there follow your access.`}
            action={
              <LinkButton to="/account" variant="secondary">
                See linked accounts
              </LinkButton>
            }
          />
        ) : claim.isError ? (
          <EmptyState
            icon={<Link2Off aria-hidden />}
            title="This link did not work"
            description={messageOf(claim.error)}
          />
        ) : (
          <Placeholder className="h-40" />
        )}
      </div>
    </Page>
  )
}
