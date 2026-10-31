import type { CredentialView } from '@holtkeeper/api'
import { X } from 'lucide-react'

import { useCredentials } from '../../api/queries.ts'
import { LinkButton, Notice, Placeholder, Select, TagInput, TextField } from '../../ui/index.ts'
import { aiProviderKinds } from '../credentials/form.ts'
import { useSession } from '../shell/session.ts'

const kindsOf: Record<string, readonly string[]> = {
  'ai-provider': aiProviderKinds,
  github: ['github'],
}

const missing: Record<string, { title: string; text: string }> = {
  'ai-provider': {
    title: 'No AI provider yet',
    text: 'Add an AI provider credential with its API key first, then pick it here.',
  },
  github: {
    title: 'No GitHub token yet',
    text: 'Add a credential of kind github with a token that reads public repositories, then pick it here.',
  },
}

/** Credentials a `x-credential` setting may name, by the kind family in its schema. */
const credentialsOf = (credentials: readonly CredentialView[], of: string) =>
  credentials.filter((c) => kindsOf[of]?.includes(c.kind) ?? true)

/** The credential a stored reference (id or name) points at. */
export const findCredential = (credentials: readonly CredentialView[], reference: unknown) =>
  credentials.find((c) => c.id === reference) ?? credentials.find((c) => c.name === reference)

function MissingNotice({ of }: { of: string }) {
  const notice = missing[of] ?? {
    title: 'No credential yet',
    text: 'Add a credential first, then pick it here.',
  }
  return (
    <Notice tone="warning" title={notice.title}>
      <span className="flex flex-col items-start gap-2">
        {notice.text}
        <LinkButton to="/credentials" size="sm">
          Open Credentials
        </LinkButton>
      </span>
    </Notice>
  )
}

const optionsOf = (credentials: readonly CredentialView[]) =>
  credentials.map((c) => ({
    id: c.id,
    text: c.name,
    label: (
      <span className="flex items-center gap-2">
        {c.name}
        <span className="font-mono text-xs text-muted">{c.kind}</span>
      </span>
    ),
  }))

/** Picks a credential for a setting that references one; stores its id. */
export function CredentialPicker({
  of,
  value,
  onChange,
  label,
}: {
  of: string
  value: unknown
  onChange: (value: string) => void
  label: string
}) {
  const { can } = useSession()
  const readable = can('credentials:read')
  const credentials = useCredentials(readable)

  if (!readable) {
    return (
      <TextField
        label={label}
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
        description="Id or name of the credential. You cannot list credentials, so type it in."
      />
    )
  }
  if (credentials.isPending) return <Placeholder className="h-16" />

  const options = credentialsOf(credentials.data?.credentials ?? [], of)
  if (options.length === 0) return <MissingNotice of={of} />
  return (
    <Select
      label={label}
      options={optionsOf(options)}
      value={findCredential(options, value)?.id}
      onChange={onChange}
      placeholder="Choose a credential…"
    />
  )
}

/**
 * Picks any number of credentials of one family; stores their ids in order. References that match
 * no credential (an old name, a deleted id) stay listed as typed until removed.
 */
export function CredentialsPicker({
  of,
  value,
  onChange,
  label,
}: {
  of: string
  value: unknown
  onChange: (value: string[]) => void
  label: string
}) {
  const { can } = useSession()
  const readable = can('credentials:read')
  const credentials = useCredentials(readable)
  const references = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : []

  if (!readable) {
    return (
      <TagInput
        label={label}
        values={references}
        onChange={onChange}
        placeholder="Type and press Enter"
        description="Ids or names of credentials. You cannot list credentials, so type them in."
      />
    )
  }
  if (credentials.isPending) return <Placeholder className="h-16" />

  const all = credentials.data?.credentials ?? []
  const options = credentialsOf(all, of)
  const chosen = new Set(references.map((r) => findCredential(all, r)?.id ?? r))
  const rest = options.filter((c) => !chosen.has(c.id))

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {references.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {references.map((reference) => {
            const credential = findCredential(all, reference)
            const name = credential?.name ?? reference
            return (
              <li
                key={reference}
                className="inline-flex items-center gap-1 rounded-lg bg-default px-2 py-0.5 text-sm"
              >
                {name}
                {credential ? (
                  <span className="font-mono text-xs text-muted">{credential.kind}</span>
                ) : (
                  <span className="text-xs text-warning">not found</span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  className="rounded p-0.5 text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus"
                  onClick={() => onChange(references.filter((r) => r !== reference))}
                >
                  <X className="size-3" />
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      {options.length === 0 ? (
        <MissingNotice of={of} />
      ) : rest.length ? (
        <Select
          aria-label={`Add to ${label}`}
          options={optionsOf(rest)}
          value={undefined}
          onChange={(id) => onChange([...references, id])}
          placeholder="Add a credential…"
        />
      ) : null}
    </div>
  )
}
