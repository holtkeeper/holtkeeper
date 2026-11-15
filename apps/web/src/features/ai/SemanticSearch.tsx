import type { KnowledgeEmbeddingsStatus, SettingView } from '@holtkeeper/api'
import { RefreshCw } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useCredentials, useSettingMutations, useSettings } from '../../api/queries.ts'
import {
  useEmbeddingModels,
  useKnowledgeEmbeddings,
  useReindexEmbeddings,
} from '../../api/settings-ai.ts'
import {
  type EmbeddingsDraft,
  embeddingModelOptions,
  embeddingsDraft,
  embeddingsStatusLine,
  parseEmbeddingsDraft,
  sameEmbeddingsDraft,
} from '../../lib/embeddings.ts'
import { settingAnchor } from '../../lib/settings-sections.ts'
import {
  Button,
  ConfirmDialog,
  ErrorState,
  Panel,
  Placeholder,
  Select,
  Switch,
  Tag,
  TextField,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

const KEY = 'knowledge.embeddings'
/** Select id of "the AI provider's credential" (the setting leaves `credential` out). */
const PROVIDER = '__provider'

/** The global entry of `knowledge.embeddings`, if one is stored. */
const globalEntry = (settings: readonly SettingView[] | undefined) =>
  settings?.find((entry) => entry.key === KEY && entry.scope.all === true)

function StatusLine({ status }: { status: KnowledgeEmbeddingsStatus }) {
  const line = embeddingsStatusLine(status)
  return (
    <div className="flex flex-col gap-1" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <Tag tone={line.tone} dot>
          {line.label}
        </Tag>
        {line.facts.map((fact) => (
          <span key={fact} className="text-muted">
            {fact}
          </span>
        ))}
      </div>
      {line.error ? (
        <p role="alert" className="text-xs text-bad">
          {line.error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Settings › AI › Semantic search: the global `knowledge.embeddings` setting (switch, `ai-sdk`
 * credential, model with its price, dimensions), the indexing status and Reindex. The form needs
 * a global `settings:write`; the status shows to anyone who reads knowledge.
 */
export function SemanticSearchPanel() {
  const { can, canGlobal } = useSession()
  const writable = canGlobal('settings:write')
  const status = useKnowledgeEmbeddings(can('knowledge:read'))
  const settings = useSettings(can('settings:read'))
  const reindex = useReindexEmbeddings()
  const [confirming, setConfirming] = useState(false)
  if (!can('knowledge:read') && !writable) return null

  const runReindex = () =>
    reindex.mutate(undefined, {
      onSuccess: () => {
        setConfirming(false)
        notify.success('Reindexing started')
      },
      onError: (error) => notify.error('Could not reindex', messageOf(error)),
    })

  return (
    <Panel
      variant="flush"
      title={<span id={settingAnchor(KEY)}>Semantic search</span>}
      description="Vectors of knowledge notes, so agents find notes by meaning and duplicates worded differently are caught. Off, search is full text."
      actions={
        writable && status.data && status.data.state !== 'off' ? (
          <Button size="sm" variant="ghost" onPress={() => setConfirming(true)}>
            <RefreshCw className="size-3.5" />
            Reindex
          </Button>
        ) : null
      }
      contentClassName="flex flex-col gap-3"
    >
      {status.isPending && can('knowledge:read') ? (
        <Placeholder className="h-6" />
      ) : status.isError ? (
        <ErrorState error={status.error} />
      ) : status.data ? (
        <StatusLine status={status.data} />
      ) : null}
      {writable ? (
        settings.isPending ? (
          <Placeholder className="h-32" />
        ) : settings.isError ? (
          <ErrorState error={settings.error} />
        ) : (
          <EmbeddingsForm
            key={globalEntry(settings.data.settings)?.updatedAt ?? 'default'}
            entry={globalEntry(settings.data.settings)}
          />
        )
      ) : null}
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title="Reindex every note?"
        confirmLabel="Reindex"
        onConfirm={runReindex}
        isPending={reindex.isPending}
      >
        Every stored vector is dropped and each note is embedded again, which counts against the AI
        budget. Search uses full text until indexing ends.
      </ConfirmDialog>
    </Panel>
  )
}

function EmbeddingsForm({ entry }: { entry: SettingView | undefined }) {
  const { can } = useSession()
  const { put } = useSettingMutations()
  const saved = embeddingsDraft(entry?.value)
  const [draft, setDraft] = useState<EmbeddingsDraft>(saved)
  const parsed = parseEmbeddingsDraft(draft)
  const dirty = !sameEmbeddingsDraft(draft, saved)
  const credentials = useCredentials(can('credentials:read'))
  const models = useEmbeddingModels(draft.credential, draft.enabled)
  const aiSdk = (credentials.data?.credentials ?? []).filter((c) => c.kind === 'ai-sdk')
  const chosen = aiSdk.find((c) => c.id === draft.credential || c.name === draft.credential)
  const options = embeddingModelOptions(models.data?.models ?? [], draft.model)

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!('value' in parsed)) return
    put.mutate(
      { ...(entry && { id: entry.id }), key: KEY, scope: { all: true }, value: parsed.value },
      {
        onSuccess: () => notify.success('Semantic search saved'),
        onError: (error) => notify.error('Could not save semantic search', messageOf(error)),
      },
    )
  }

  return (
    <form
      aria-label="Semantic search settings"
      onSubmit={save}
      className="flex flex-col gap-3 rounded-[10px] border border-line bg-raise p-3"
    >
      <Switch
        label="Use vectors for knowledge search, the Guide and duplicate checks"
        isSelected={draft.enabled}
        onChange={(enabled) => setDraft({ ...draft, enabled })}
      />
      {draft.enabled ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {can('credentials:read') ? (
            <Select
              label="Credential"
              options={[
                { id: PROVIDER, label: 'The AI provider’s (llm.provider)', text: 'AI provider' },
                ...aiSdk.map((c) => ({ id: c.id, label: c.name, text: c.name })),
              ]}
              value={chosen?.id ?? (draft.credential ? undefined : PROVIDER)}
              onChange={(id) => setDraft({ ...draft, credential: id === PROVIDER ? '' : id })}
            />
          ) : (
            <TextField
              label="Credential"
              value={draft.credential}
              onChange={(credential) => setDraft({ ...draft, credential })}
              description="Id or name of an ai-sdk credential; empty for the AI provider’s."
            />
          )}
          {options.length ? (
            <Select
              label="Model"
              options={options.map((option) => ({
                id: option.id,
                text: option.id,
                label: (
                  <span className="flex flex-col">
                    <span className="font-mono text-[12.5px]">{option.id}</span>
                    {option.detail || option.unlisted ? (
                      <span className="text-xs text-muted">
                        {option.unlisted ? 'not listed by the endpoint' : option.detail}
                      </span>
                    ) : null}
                  </span>
                ),
              }))}
              value={draft.model}
              onChange={(model) => setDraft({ ...draft, model })}
            />
          ) : (
            <TextField
              label="Model"
              value={draft.model}
              onChange={(model) => setDraft({ ...draft, model })}
              mono
            />
          )}
          <TextField
            label="Dimensions"
            value={draft.dimensions}
            onChange={(dimensions) => setDraft({ ...draft, dimensions })}
            placeholder="Model’s own"
            description="Only for models that can shorten their vectors."
            mono
          />
        </div>
      ) : null}
      {draft.enabled && (models.data?.error || models.isError) ? (
        <p className="text-xs text-warning">
          Could not list models: {models.data?.error ?? messageOf(models.error)}. Type the model
          instead.
        </p>
      ) : null}
      {'error' in parsed ? (
        <p role="alert" className="text-xs text-bad">
          {parsed.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">
          Embedding calls count against the weekly AI budget as automatic work (task kind
          embedding).
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          isDisabled={!dirty || put.isPending}
          onPress={() => setDraft(saved)}
        >
          Cancel
        </Button>
        <Button
          variant="secondary"
          size="sm"
          type="submit"
          isDisabled={!dirty || 'error' in parsed}
          isPending={put.isPending}
        >
          Save
        </Button>
      </div>
    </form>
  )
}
