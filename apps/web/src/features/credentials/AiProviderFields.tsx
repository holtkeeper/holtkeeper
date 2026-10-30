import type { AiCatalogProviderView } from '@holtkeeper/api'
import { Check, ExternalLink, Plus } from 'lucide-react'
import { useState } from 'react'

import { useAiProviderModels, useAiProviders } from '../../api/queries.ts'
import { Notice, Placeholder, SearchInput, Select, TextField } from '../../ui/index.ts'
import {
  type AiDraft,
  type DraftErrors,
  OPENAI_COMPATIBLE,
  agentModels,
  filterProviders,
} from './form.ts'

const shown = 80

const price = (value: number | undefined) => (value === undefined ? '' : `$${value}`)

/** Provider, model, endpoint and options of an `ai-sdk` credential. */
export function AiProviderFields({
  ai,
  errors,
  onChange,
  onPick,
}: {
  ai: AiDraft
  errors: DraftErrors
  onChange: (patch: Partial<AiDraft>) => void
  /** A catalog provider was chosen; the dialog fills in the name and URL. */
  onPick: (provider: AiCatalogProviderView | undefined) => void
}) {
  const [query, setQuery] = useState('')
  const catalog = useAiProviders()
  const providers = catalog.data?.providers ?? []
  const picked = ai.custom ? undefined : providers.find((p) => p.id === ai.provider)
  const models = useAiProviderModels(picked?.id)
  const options = agentModels(models.data?.models ?? [])
  const matches = filterProviders(providers, query)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Provider</span>
        {catalog.data?.error ? (
          <Notice tone="warning" title="The provider catalog is unavailable">
            {catalog.data.error}. You can still add a provider of your own.
          </Notice>
        ) : null}
        <SearchInput
          aria-label="Search providers"
          placeholder={`Search ${providers.length || ''} providers: OpenRouter, Groq, Gemini…`}
          value={query}
          onChange={setQuery}
        />
        <ul className="flex max-h-60 flex-col gap-0.5 overflow-y-auto rounded-xl border border-separator p-1">
          <li>
            <button
              type="button"
              aria-pressed={ai.custom}
              onClick={() => {
                onChange({ custom: true, provider: '', package: OPENAI_COMPATIBLE })
                onPick(undefined)
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-default-soft ${ai.custom ? 'bg-accent-soft text-accent-soft-foreground' : ''}`}
            >
              <Plus className="size-3.5" />
              <span className="font-medium">A provider of your own</span>
              <span className="ml-auto text-xs text-muted">
                any OpenAI- or Anthropic-compatible API
              </span>
            </button>
          </li>
          {catalog.isPending ? (
            <li>
              <Placeholder className="h-24" />
            </li>
          ) : null}
          {matches.slice(0, shown).map((provider) => {
            const active = !ai.custom && provider.id === ai.provider
            return (
              <li key={provider.id}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    onChange({
                      custom: false,
                      provider: provider.id,
                      package: provider.package,
                      model: '',
                    })
                    onPick(provider)
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-default-soft ${active ? 'bg-accent-soft text-accent-soft-foreground' : ''}`}
                >
                  {active ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                  <span className="font-medium">{provider.name}</span>
                  <span className="font-mono text-xs text-muted">{provider.id}</span>
                  <span className="ml-auto text-xs text-muted">
                    {provider.toolModels} agent model{provider.toolModels === 1 ? '' : 's'}
                  </span>
                </button>
              </li>
            )
          })}
          {matches.length > shown ? (
            <li className="px-2.5 py-1.5 text-xs text-muted">
              {matches.length - shown} more — narrow the search
            </li>
          ) : null}
        </ul>
        {errors.provider && !ai.custom ? (
          <span className="text-xs text-danger">{errors.provider}</span>
        ) : null}
        {picked?.doc ? (
          <a
            href={picked.doc}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 self-start text-xs text-muted hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            {picked.name} docs
          </a>
        ) : null}
      </div>

      {ai.custom ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Provider name"
            value={ai.provider}
            onChange={(provider) => onChange({ provider })}
            error={errors.provider}
            placeholder="e.g. corp-gateway"
            mono
          />
          <Select
            label="AI SDK package"
            options={(catalog.data?.packages ?? [OPENAI_COMPATIBLE]).map((pkg) => ({
              id: pkg,
              label: <span className="font-mono text-xs">{pkg}</span>,
              text: pkg,
            }))}
            value={ai.package}
            onChange={(pkg) => onChange({ package: pkg })}
          />
        </div>
      ) : null}

      <TextField
        label="Base URL"
        type="url"
        value={ai.baseUrl}
        onChange={(baseUrl) => onChange({ baseUrl })}
        error={errors.baseUrl}
        placeholder={
          picked?.api ??
          (ai.package === OPENAI_COMPATIBLE ? 'https://llm.example.com/v1' : 'The provider default')
        }
        description={
          ai.package === OPENAI_COMPATIBLE
            ? 'API root that /chat/completions is appended to.'
            : 'Optional: a proxy or regional endpoint instead of the default.'
        }
        mono
      />

      {picked && options.length ? (
        <Select
          label="Default model"
          options={options.map((model) => ({
            id: model.id,
            text: model.name ?? model.id,
            label: (
              <span className="flex w-full items-center gap-2">
                <span className="truncate">{model.name ?? model.id}</span>
                <span className="ml-auto font-mono text-xs text-muted">
                  {[price(model.pricing?.inputPerMTok), price(model.pricing?.outputPerMTok)]
                    .filter(Boolean)
                    .join(' / ')}
                </span>
              </span>
            ),
          }))}
          value={ai.model || undefined}
          onChange={(model) => onChange({ model })}
          placeholder="Choose a model…"
        />
      ) : (
        <TextField
          label="Default model"
          value={ai.model}
          onChange={(model) => onChange({ model })}
          placeholder="e.g. openai/gpt-5"
          description="Optional here; llm.model in settings can choose per scope."
          mono
        />
      )}

      <TextField
        label="Advanced options"
        multiline
        rows={5}
        mono
        value={ai.advanced}
        onChange={(advanced) => onChange({ advanced })}
        error={errors.advanced}
        placeholder={
          '{\n  "headers": { "X-Team": "platform" },\n  "settings": { "region": "us-east-1" },\n  "maxConcurrency": 4\n}'
        }
        description="JSON: headers ({secret} is the key), settings of the AI SDK provider, models per task, modelMap, pricing, timeoutMs, maxConcurrency."
      />
    </div>
  )
}
