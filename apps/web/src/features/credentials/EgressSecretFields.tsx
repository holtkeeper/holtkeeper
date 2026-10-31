import { RefreshCw } from 'lucide-react'

import { Button, CopyField, MultiToggle, TagInput } from '../../ui/index.ts'
import {
  type DraftErrors,
  type EgressDraft,
  egressHostError,
  egressPathError,
  egressTargets,
  newPlaceholder,
} from './form.ts'

const targetLabels: Record<EgressDraft['targets'][number], string> = {
  headers: 'Headers',
  url: 'URL',
  body: 'Body',
}

/** Placeholder and request matching of an egress secret (kind `egress-secret`). */
export function EgressSecretFields({
  egress,
  errors,
  onChange,
}: {
  egress: EgressDraft
  errors: DraftErrors
  onChange: (patch: Partial<EgressDraft>) => void
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-separator p-3">
      <legend className="px-1 text-sm font-medium">Egress proxy</legend>
      <p className="text-xs text-muted">
        Jobs get the placeholder instead of the secret, e.g. as an environment variable. The egress
        proxy swaps it for the secret in requests to the URL's host and the hosts below, and nowhere
        else. Over plain HTTP only when the URL is http://.
      </p>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Placeholder</span>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <CopyField label="placeholder" value={egress.placeholder} />
          </div>
          <Button
            variant="secondary"
            isIconOnly
            aria-label="New placeholder"
            onPress={() => onChange({ placeholder: newPlaceholder() })}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
        {errors.placeholder ? (
          <span className="text-xs text-danger">{errors.placeholder}</span>
        ) : (
          <span className="text-xs text-muted">
            Not secret. A new one stops the old one from working once saved.
          </span>
        )}
      </div>
      <TagInput
        label="More hosts"
        values={egress.hosts}
        onChange={(hosts) => onChange({ hosts })}
        validate={egressHostError}
        placeholder="cache.example.com or *.example.com"
      />
      <TagInput
        label="Paths"
        values={egress.paths}
        onChange={(paths) => onChange({ paths })}
        validate={egressPathError}
        placeholder="^/v8/artifacts"
        description="Regular expressions searched in the path with its query. None: every path."
      />
      <TagInput
        label="Methods"
        values={egress.methods}
        onChange={(methods) => onChange({ methods })}
        placeholder="GET"
        description="None: every method."
      />
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Replace in</span>
        <MultiToggle
          aria-label="Replace in"
          options={egressTargets.map((id) => ({ id, label: targetLabels[id] }))}
          value={egress.targets}
          onChange={(targets) => onChange({ targets })}
        />
        <span className={`text-xs ${errors.targets ? 'text-danger' : 'text-muted'}`}>
          {errors.targets ??
            'Headers is safest: a server that stores the URL or body could hand the secret back to a job.'}
        </span>
      </div>
    </fieldset>
  )
}
