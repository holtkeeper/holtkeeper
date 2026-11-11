import type { PersonView } from '@holtkeeper/api'
import { useState } from 'react'

import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { personOf } from '../../lib/people.ts'
import { Avatar, Markdown, Segmented, TextField } from '../../ui/index.ts'

/** "edited by <avatar> Ann · 3d ago": a person named by id with when they did it. */
export function Byline({
  verb,
  id,
  at,
  people,
}: {
  verb: string
  id: string | undefined
  at: string | undefined
  people: Readonly<Record<string, PersonView>>
}) {
  if (!id) return null
  const person = personOf(people, id)
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted">
      {verb} by
      <Avatar src={person.avatarUrl} name={person.name} size="xs" />
      <span className={`truncate ${person.known ? 'font-medium text-foreground' : 'mono'}`}>
        {person.name}
      </span>
      {at ? (
        <>
          <span aria-hidden>·</span>
          <span className="mono" title={formatDateTime(at)}>
            {formatRelative(at)}
          </span>
        </>
      ) : null}
    </span>
  )
}

/** A Markdown textarea with a Write / Preview switch. */
export function MarkdownEditor({
  label,
  value,
  onChange,
  placeholder,
  rows = 8,
  description,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  description?: string
}) {
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        <Segmented
          aria-label={`${label} mode`}
          options={[
            { id: 'write', label: 'Write' },
            { id: 'preview', label: 'Preview' },
          ]}
          value={mode}
          onChange={setMode}
        />
      </div>
      {mode === 'write' ? (
        <TextField
          aria-label={label}
          value={value}
          onChange={onChange}
          multiline
          rows={rows}
          mono
          {...(placeholder ? { placeholder } : {})}
          {...(description ? { description } : {})}
        />
      ) : (
        <div className="min-h-24 rounded-lg border border-line bg-raise p-3">
          {value.trim() ? (
            <Markdown text={value} />
          ) : (
            <span className="text-sm text-muted">Nothing to preview.</span>
          )}
        </div>
      )}
    </div>
  )
}
