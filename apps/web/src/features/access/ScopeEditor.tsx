import type { Scope } from '@holtkeeper/api'
import { Globe2, Layers } from 'lucide-react'

import {
  describeScope,
  formatGroupMatch,
  parseGroupMatch,
  validateGroupMatch,
  validateRepoPattern,
} from '../../lib/scope.ts'
import { Chip, Segmented, TagInput } from '../../ui/index.ts'

/** Which repositories something applies to: everything, or groups plus `forge:path/**` patterns. */
export function ScopeEditor({
  value,
  onChange,
  groups = [],
  label = 'Scope',
}: {
  value: Scope
  onChange: (scope: Scope) => void
  /** Known groups, offered as suggestions. */
  groups?: readonly string[]
  label?: string
}) {
  const mode = value.all ? 'all' : 'some'
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <Segmented
        aria-label={`${label} mode`}
        options={[
          {
            id: 'all',
            label: (
              <span className="flex items-center gap-1.5">
                <Globe2 className="size-3.5" />
                Everything
              </span>
            ),
          },
          {
            id: 'some',
            label: (
              <span className="flex items-center gap-1.5">
                <Layers className="size-3.5" />
                Groups and repositories
              </span>
            ),
          },
        ]}
        value={mode}
        onChange={(next) => onChange(next === 'all' ? { all: true } : { groups: [], repos: [] })}
      />
      {mode === 'some' ? (
        <div className="flex flex-col gap-3 rounded-xl border border-separator p-3">
          <TagInput
            label="Groups"
            values={(value.groups ?? []).map(formatGroupMatch)}
            onChange={(next) => onChange({ ...value, groups: next.map(parseGroupMatch) })}
            placeholder="e.g. games"
            suggestions={groups}
            validate={validateGroupMatch}
            description="Join groups with + to require all of them: frontend + storefront"
          />
          <TagInput
            label="Repository patterns"
            values={value.repos ?? []}
            onChange={(next) => onChange({ ...value, repos: next })}
            placeholder="e.g. work:games/**"
            validate={validateRepoPattern}
            description="Path globs, optionally prefixed by a forge id: work:games/**, tools/cli"
          />
        </div>
      ) : null}
    </fieldset>
  )
}

/** Read-only scope summary. */
export function ScopeBadge({ scope }: { scope: Scope }) {
  return (
    <Chip tone={scope.all ? 'accent' : 'default'} className="max-w-full">
      <span className="truncate font-mono text-[11px]">{describeScope(scope)}</span>
    </Chip>
  )
}
