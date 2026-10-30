import type { AccountChallenge, ExternalAccountView } from '@holtkeeper/api'
import { BadgeCheck, Link2, Plus, ShieldQuestion, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

import { ApiError, messageOf } from '../../api/client.ts'
import { useAccountMutations, useAccounts, useForges } from '../../api/queries.ts'
import {
  type LinkDraft,
  challengePending,
  forgeProviders,
  numericIdProvider,
  providerLabel,
  splitProvider,
  toLinkInput,
  validateLinkDraft,
  verificationLabel,
} from '../../lib/accounts.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  CopyField,
  Dialog,
  EmptyState,
  ErrorState,
  Notice,
  Panel,
  Placeholder,
  Select,
  TextField,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503
const otherProvider = '__other'

/** The signed-in principal's linked GitLab, GitHub and Slack accounts, with self-verification. */
export function ExternalAccounts() {
  const accounts = useAccounts()
  const { unlink, challenge } = useAccountMutations()
  const [linking, setLinking] = useState(false)
  const [removing, setRemoving] = useState<ExternalAccountView>()
  const [issued, setIssued] = useState<{
    account: ExternalAccountView
    challenge: AccountChallenge
  }>()
  const [verifying, setVerifying] = useState<string>()
  const now = new Date()

  const description =
    'Link the accounts you use on forges and chat so bots and merge request commands act as you. A link counts only once it is verified.'

  if (accounts.isPending)
    return (
      <Panel title="External accounts" description={description}>
        <Placeholder className="h-24" />
      </Panel>
    )
  if (accounts.isError) {
    return (
      <Panel title="External accounts" description={description}>
        {unavailable(accounts.error) ? (
          <p className="text-sm text-muted">
            External accounts are not available on this server: its store keeps no account links.
          </p>
        ) : (
          <ErrorState error={accounts.error} />
        )}
      </Panel>
    )
  }

  const list = accounts.data.accounts
  const verify = (account: ExternalAccountView) => {
    setVerifying(account.id)
    challenge.mutate(account.id, {
      onSuccess: (result) => setIssued({ account, challenge: result }),
      onError: (error) => notify.error('No code issued', messageOf(error)),
      onSettled: () => setVerifying(undefined),
    })
  }

  return (
    <Panel
      title="External accounts"
      description={description}
      actions={
        <Button variant="secondary" size="sm" onPress={() => setLinking(true)}>
          <Plus className="size-3.5" />
          Link account
        </Button>
      }
    >
      {list.length ? (
        <ul className="flex flex-col divide-y divide-separator">
          <AnimatePresence initial={false}>
            {list.map((account) => {
              const state = verificationLabel(account.verification)
              const verified = account.verification !== 'unverified'
              const pending = challengePending(account, now)
              const name = account.username ? `@${account.username}` : account.externalId
              return (
                <motion.li
                  key={account.id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
                >
                  <span
                    className={`grid size-9 place-items-center rounded-xl ${verified ? 'bg-success-soft text-success-soft-foreground' : 'bg-warning-soft text-warning-soft-foreground'}`}
                  >
                    {verified ? (
                      <BadgeCheck className="size-4" />
                    ) : (
                      <ShieldQuestion className="size-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{providerLabel(account.provider)}</span>
                      <span className="truncate font-mono text-xs">{name}</span>
                      {account.username ? (
                        <span className="font-mono text-xs text-muted">
                          id {account.externalId}
                        </span>
                      ) : null}
                      <span title={state.description}>
                        <Chip tone={state.tone} size="sm">
                          {state.text}
                        </Chip>
                      </span>
                    </div>
                    <div className="text-xs text-muted">
                      <span title={formatDateTime(account.linkedAt)}>
                        Linked {formatRelative(account.linkedAt, now)}
                      </span>
                      {account.verifiedAt ? (
                        <>
                          {' · '}
                          <span title={formatDateTime(account.verifiedAt)}>
                            verified {formatRelative(account.verifiedAt, now)}
                          </span>
                        </>
                      ) : null}
                      {pending && account.challengeExpiresAt ? (
                        <>
                          {' · '}
                          <span title={formatDateTime(account.challengeExpiresAt)}>
                            code expires {formatRelative(account.challengeExpiresAt, now)}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <span className="flex gap-1">
                    {!verified ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        isPending={verifying === account.id}
                        onPress={() => verify(account)}
                      >
                        {pending ? 'New code' : 'Verify'}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      aria-label={`Unlink ${providerLabel(account.provider)} ${name}`}
                      onPress={() => setRemoving(account)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </span>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
      ) : (
        <EmptyState
          icon={<Link2 />}
          title="No linked accounts"
          description="Link your GitLab user to run merge request commands as yourself."
        />
      )}

      {linking ? <LinkDialog isOpen onOpenChange={setLinking} /> : null}
      {issued ? (
        <ChallengeDialog
          account={issued.account}
          challenge={issued.challenge}
          onClose={() => setIssued(undefined)}
        />
      ) : null}
      <ConfirmDialog
        isOpen={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined)
        }}
        title="Unlink this account?"
        confirmLabel="Unlink"
        isPending={unlink.isPending}
        onConfirm={() => {
          if (!removing) return
          unlink.mutate(removing.id, {
            onSuccess: () => {
              notify.success('Account unlinked', providerLabel(removing.provider))
              setRemoving(undefined)
            },
            onError: (error) => notify.error('Account not unlinked', messageOf(error)),
          })
        }}
      >
        Bots and webhooks stop treating{' '}
        {removing
          ? `${providerLabel(removing.provider)} ${removing.username ?? removing.externalId}`
          : 'it'}{' '}
        as you.
        {removing && removing.verification !== 'unverified'
          ? ' Linking it again needs a new verification.'
          : ''}
      </ConfirmDialog>
    </Panel>
  )
}

function LinkDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { can } = useSession()
  const forges = useForges(can('settings:read'))
  const { link } = useAccountMutations()
  const suggestions = forgeProviders(
    (forges.data?.entries ?? []).map((entry) => ({ id: entry.id, kind: entry.data.kind })),
  )
  const [choice, setChoice] = useState<string>()
  const [draft, setDraft] = useState<LinkDraft>({ provider: '', externalId: '', username: '' })
  const [submitted, setSubmitted] = useState(false)
  const picked = choice ?? suggestions[0]?.id ?? otherProvider
  const provider = picked === otherProvider ? draft.provider : picked
  const full = { ...draft, provider }
  const errors = submitted ? validateLinkDraft(full) : {}
  const set = (patch: Partial<LinkDraft>) => setDraft((d) => ({ ...d, ...patch }))

  const submit = () => {
    setSubmitted(true)
    if (Object.keys(validateLinkDraft(full)).length) return
    link.mutate(toLinkInput(full), {
      onSuccess: () => {
        notify.success('Account linked', 'Verify it so bots act on it.')
        onOpenChange(false)
      },
    })
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Link an external account"
      description="The link starts unverified. Verify it afterwards by posting a one-time code from that account."
      footer={
        <>
          <Button variant="tertiary" onPress={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" isPending={link.isPending} onPress={submit}>
            Link
          </Button>
        </>
      }
    >
      {suggestions.length ? (
        <Select
          label="Provider"
          value={picked}
          onChange={setChoice}
          options={[...suggestions, { id: otherProvider, label: 'Other…', text: 'Other' }]}
        />
      ) : null}
      {picked === otherProvider ? (
        <TextField
          label={suggestions.length ? 'Provider id' : 'Provider'}
          value={draft.provider}
          onChange={(value) => set({ provider: value })}
          placeholder="gitlab:<forge id> or slack:<workspace>"
          description="gitlab:<forge id>, github:<forge id> or slack:<workspace id>."
          error={errors.provider}
          mono
          autoFocus
        />
      ) : null}
      <TextField
        label={numericIdProvider(provider) ? 'User id' : 'Account id'}
        value={draft.externalId}
        onChange={(value) => set({ externalId: value })}
        placeholder={numericIdProvider(provider) ? '42' : 'U0123ABCD'}
        description={
          numericIdProvider(provider)
            ? 'The numeric id from your profile page, not the username: usernames can be renamed and reused.'
            : 'The stable id the provider assigns to your account.'
        }
        error={errors.externalId}
        isRequired
        mono
      />
      <TextField
        label="Username"
        value={draft.username}
        onChange={(value) => set({ username: value })}
        placeholder="jane"
        description="Optional, for display. Verification replaces it with the name the provider reports."
      />
      {link.isError ? (
        <Notice tone="danger" title="Not linked">
          {messageOf(link.error)}
        </Notice>
      ) : null}
    </Dialog>
  )
}

function ChallengeDialog({
  account,
  challenge,
  onClose,
}: {
  account: ExternalAccountView
  challenge: AccountChallenge
  onClose: () => void
}) {
  const { kind } = splitProvider(account.provider)
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`Verify ${providerLabel(account.provider)}`}
      description="This code is shown once. Requesting another one replaces it."
      footer={
        <Button variant="primary" onPress={onClose}>
          Done
        </Button>
      }
    >
      <p className="text-sm">
        {kind === 'slack'
          ? 'Send this command to the Holtkeeper bot from your Slack account:'
          : 'Post this command as a merge request or issue comment from that account:'}
      </p>
      <CopyField value={challenge.command} label="verification command" />
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">Code</span>
        <CopyField value={challenge.code} label="verification code" />
      </div>
      <p className="text-sm text-muted">
        Valid until{' '}
        <span title={formatDateTime(challenge.expiresAt)}>
          {formatDateTime(challenge.expiresAt)} ({formatRelative(challenge.expiresAt)})
        </span>
        . Five wrong codes cancel it. The account turns verified once the comment arrives.
      </p>
    </Dialog>
  )
}
