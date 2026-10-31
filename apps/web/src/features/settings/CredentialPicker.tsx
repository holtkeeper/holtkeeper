import type { CredentialView } from '@holtkeeper/api'

import { useCredentials } from '../../api/queries.ts'
import { LinkButton, Notice, Placeholder, Select, TextField } from '../../ui/index.ts'
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
  if (options.length === 0) {
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
  return (
    <Select
      label={label}
      options={options.map((c) => ({
        id: c.id,
        text: c.name,
        label: (
          <span className="flex items-center gap-2">
            {c.name}
            <span className="font-mono text-xs text-muted">{c.kind}</span>
          </span>
        ),
      }))}
      value={findCredential(options, value)?.id}
      onChange={onChange}
      placeholder="Choose a credential…"
    />
  )
}
