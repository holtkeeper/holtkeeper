import type { CredentialView, ProviderModelView } from '@holtkeeper/api'

import { useCredentialModels } from '../../api/queries.ts'
import { formatDate } from '../../lib/format.ts'
import {
  Chip,
  Dialog,
  EmptyState,
  ErrorState,
  Notice,
  Placeholder,
  Table,
  Td,
  Th,
} from '../../ui/index.ts'

const price = (value: number | undefined) =>
  value === undefined ? '—' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`

const newestFirst = (a: ProviderModelView, b: ProviderModelView) =>
  (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id)

/** The models an AI provider credential offers, with prices per million tokens when known. */
export function ModelsDialog({
  credential,
  onClose,
}: {
  credential: CredentialView
  onClose: () => void
}) {
  const models = useCredentialModels(credential.id)
  const list = (models.data?.models ?? []).toSorted(newestFirst)

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={`${credential.name} models`}
      description="Use <prefix>@latest in llm.model or llm.models to always run the newest version, e.g. claude-opus@latest."
    >
      {models.isPending ? <Placeholder className="h-48" /> : null}
      {models.isError ? <ErrorState error={models.error} /> : null}
      {models.data?.error ? (
        <Notice tone="warning" title="The provider did not list its models">
          {models.data.error}. Only the models named in the credential are shown.
        </Notice>
      ) : null}
      {models.data && list.length === 0 ? <EmptyState title="No models" /> : null}
      {list.length ? (
        <Table label={`${credential.name} models`}>
          <thead>
            <tr>
              <Th>Model</Th>
              <Th>Released</Th>
              <Th align="right">Input / MTok</Th>
              <Th align="right">Output / MTok</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((model) => (
              <tr key={model.id}>
                <Td>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{model.id}</span>
                    {model.source === 'config' ? <Chip>configured</Chip> : null}
                    {model.toolCall === false ? <Chip tone="warning">no tools</Chip> : null}
                  </span>
                  {model.name ? (
                    <span className="block text-xs text-muted">{model.name}</span>
                  ) : null}
                </Td>
                <Td className="text-xs text-muted">
                  {model.createdAt ? formatDate(model.createdAt) : '—'}
                </Td>
                <Td align="right" className="tabular-nums">
                  {price(model.pricing?.inputPerMTok)}
                </Td>
                <Td align="right" className="tabular-nums">
                  {price(model.pricing?.outputPerMTok)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Dialog>
  )
}
