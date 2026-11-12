import type { CredentialView } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Fragment, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useCredentialMutations, useCredentials, useGitHubTokens } from '../../api/queries.ts'
import {
  type CredentialGroup,
  credentialGroup,
  credentialStatus,
  lastUsedLabel,
  sortCredentials,
  usedByLabel,
} from '../../lib/credential-status.ts'
import { formatDate, formatDateTime } from '../../lib/format.ts'
import { defaultGitHubRange } from '../../lib/github-usage.ts'
import { describeScope } from '../../lib/scope.ts'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Placeholder,
  SearchInput,
  SegmentedTabs,
  Table,
  Tag,
  Td,
  Th,
  Tr,
  notify,
} from '../../ui/index.ts'
import { SettingsSection } from '../settings/SettingsSection.tsx'
import { useSession } from '../shell/session.ts'
import { CredentialDialog } from './CredentialDialog.tsx'
import { GitHubCredentialUsage, usageHidden } from './GitHubUsage.tsx'

type Filter = 'all' | Exclude<CredentialGroup, 'ai'>

const filters: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'forge', label: 'Forge tokens' },
  { id: 'proxy', label: 'Proxy secrets' },
  { id: 'other', label: 'Other' },
]

const matches = (credential: CredentialView, query: string) => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const text = `${credential.name} ${credential.url} ${credential.kind}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

function UsedBy({ credential }: { credential: CredentialView }) {
  const label = usedByLabel(credential.usedBy)
  const first = credential.usedBy?.[0]
  const title = credential.usedBy?.map((use) => use.label).join(', ')
  if (first?.href)
    return (
      <Link to={first.href} className="text-xs hover:underline" {...(title && { title })}>
        {label}
      </Link>
    )
  return (
    <span className={`text-xs ${credential.usedBy?.length ? '' : 'text-muted'}`} title={title}>
      {label}
    </span>
  )
}

/**
 * Settings › Integrations › Credentials: every credential except AI provider keys as a table with
 * what uses it, its scope, expiry, rotation, last use and status, sorted by status then expiry.
 */
export function CredentialsTable() {
  const { can, canGlobal } = useSession()
  const credentials = useCredentials()
  const { rotate, remove } = useCredentialMutations()
  const [editing, setEditing] = useState<CredentialView | 'new' | null>(null)
  const [deleting, setDeleting] = useState<CredentialView | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const writable = can('credentials:write')
  const github = useGitHubTokens(defaultGitHubRange, canGlobal('settings:read'))
  const githubTokens = usageHidden(github.error) ? undefined : github.data?.tokens
  const now = new Date()
  const all = (credentials.data?.credentials ?? []).filter(
    (credential) => credentialGroup(credential.kind) !== 'ai',
  )
  const count = (id: Filter) =>
    id === 'all' ? all.length : all.filter((c) => credentialGroup(c.kind) === id).length
  const rows = sortCredentials(
    all.filter(
      (credential) =>
        (filter === 'all' || credentialGroup(credential.kind) === filter) &&
        matches(credential, query),
    ),
    now,
  )

  return (
    <SettingsSection
      title={<span id="credentials">Credentials</span>}
      description="Forge tokens, proxy secrets and other keys. Sealed by the vault, never shown again after saving."
      actions={
        writable ? (
          <Button variant="secondary" size="sm" onPress={() => setEditing('new')}>
            <Plus className="size-4" />
            Add credential
          </Button>
        ) : null
      }
    >
      {credentials.isPending ? (
        <Placeholder className="h-40" />
      ) : credentials.isError ? (
        <ErrorState error={credentials.error} />
      ) : all.length === 0 ? (
        <EmptyState
          icon={<KeyRound />}
          title="No credentials yet"
          description="Add a forge token so Holtkeeper can reach your repositories."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              aria-label="Search credentials"
              placeholder="Name, host or kind"
              value={query}
              onChange={setQuery}
              className="w-56"
            />
            <SegmentedTabs
              aria-label="Credential kinds"
              items={filters.map((item) => ({
                id: item.id,
                label: (
                  <>
                    {item.label} <span className="mono text-dim">{count(item.id)}</span>
                  </>
                ),
              }))}
              selected={filter}
              onSelect={(id) => setFilter(filters.find((item) => item.id === id)?.id ?? 'all')}
            />
            <span className="flex-1" />
            <span className="text-xs text-muted">Sorted by status, then expiry</span>
          </div>
          <Table label="Credentials">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Kind</Th>
                <Th>Used by</Th>
                <Th>Usable by</Th>
                <Th>Expires</Th>
                <Th>Rotation</Th>
                <Th>Last used</Th>
                <Th>Status</Th>
                {writable ? (
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((credential) => {
                const status = credentialStatus(credential, now)
                const token =
                  credential.kind === 'github' && githubTokens
                    ? githubTokens.find((item) => item.credentialId === credential.id)
                    : undefined
                return (
                  <Fragment key={credential.id}>
                    <Tr>
                      <Td valign="top">
                        <div className="font-medium">{credential.name}</div>
                        <div className="max-w-56 truncate mono text-xs text-muted">
                          {credential.url}
                        </div>
                      </Td>
                      <Td valign="top">
                        <Tag mono>{credential.kind}</Tag>
                      </Td>
                      <Td valign="top">
                        <UsedBy credential={credential} />
                      </Td>
                      <Td valign="top">
                        <span className="mono text-xs">{describeScope(credential.scope)}</span>
                      </Td>
                      <Td valign="top" className="whitespace-nowrap mono text-xs">
                        {credential.expiresAt ? formatDate(credential.expiresAt) : 'Never'}
                      </Td>
                      <Td valign="top" className="text-xs">
                        {credential.rotation?.enabled
                          ? `${credential.rotation.daysBefore} d before`
                          : credential.rotatable
                            ? 'By hand'
                            : '—'}
                      </Td>
                      <Td valign="top" className="whitespace-nowrap text-xs">
                        <span
                          title={
                            credential.lastUsedAt
                              ? formatDateTime(credential.lastUsedAt)
                              : undefined
                          }
                        >
                          {lastUsedLabel(credential.lastUsedAt, now)}
                        </span>
                      </Td>
                      <Td valign="top">
                        <Tag tone={status.tone} dot>
                          {status.label}
                        </Tag>
                        {status.why ? (
                          <div className="mt-0.5 max-w-48 text-xs text-muted">{status.why}</div>
                        ) : null}
                      </Td>
                      {writable ? (
                        <Td valign="top" className="whitespace-nowrap">
                          {credential.rotatable ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              isIconOnly
                              aria-label={`Rotate ${credential.name} now`}
                              isPending={rotate.isPending && rotate.variables === credential.id}
                              onPress={() =>
                                rotate.mutate(credential.id, {
                                  onSuccess: () => notify.success('Rotated', credential.name),
                                  onError: (error) =>
                                    notify.error('Rotation failed', messageOf(error)),
                                })
                              }
                            >
                              <RefreshCw className="size-3.5" />
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            isIconOnly
                            aria-label={`Edit ${credential.name}`}
                            onPress={() => setEditing(credential)}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            isIconOnly
                            aria-label={`Delete ${credential.name}`}
                            onPress={() => setDeleting(credential)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </Td>
                      ) : null}
                    </Tr>
                    {credential.kind === 'github' && githubTokens ? (
                      <tr>
                        <td
                          colSpan={writable ? 9 : 8}
                          className="border-b border-separator px-3.5 pb-3"
                        >
                          <GitHubCredentialUsage
                            token={token}
                            tokens={githubTokens}
                            days={defaultGitHubRange}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </Table>
          {rows.length === 0 ? <p className="text-xs text-muted">No credential matches.</p> : null}
        </div>
      )}
      {editing ? (
        <CredentialDialog
          key={editing === 'new' ? 'new' : editing.id}
          isOpen
          onOpenChange={(open) => !open && setEditing(null)}
          {...(editing === 'new' ? {} : { credential: editing })}
        />
      ) : null}
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'credential'}?`}
        isPending={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              notify.success('Credential deleted', deleting.name)
              setDeleting(null)
            },
            onError: (error) => notify.error('Delete failed', messageOf(error)),
          })
        }
      >
        {deleting?.usedBy?.length
          ? `${usedByLabel(deleting.usedBy)} stops working until another credential covers it.`
          : 'Nothing refers to this credential.'}
      </ConfirmDialog>
    </SettingsSection>
  )
}
