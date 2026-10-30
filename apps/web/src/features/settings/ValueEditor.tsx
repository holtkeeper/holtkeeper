import { useState } from 'react'

import { type EditorKind, parseJson } from '../../lib/schema.ts'
import { Select, Switch, TextField } from '../../ui/index.ts'

/**
 * Edits one setting value with the editor its schema calls for. Reports `undefined` through
 * `onChange` while the input cannot be turned into a value (invalid JSON, empty secret).
 */
export function ValueEditor({
  editor,
  initial,
  onChange,
  label,
  hasStoredSecret,
}: {
  editor: EditorKind
  initial: unknown
  onChange: (value: unknown) => void
  label: string
  hasStoredSecret?: boolean
}) {
  const [text, setText] = useState(() =>
    editor.kind === 'json'
      ? JSON.stringify(initial ?? null, null, 2)
      : typeof initial === 'string' || typeof initial === 'number'
        ? String(initial)
        : '',
  )
  const [error, setError] = useState<string>()

  switch (editor.kind) {
    case 'boolean':
      return <Switch label={label} isSelected={initial === true} onChange={onChange} />
    case 'enum':
      return (
        <Select
          label={label}
          options={editor.options.map((option) => ({ id: option, label: option }))}
          value={typeof initial === 'string' ? initial : undefined}
          onChange={onChange}
        />
      )
    case 'secret':
      return (
        <TextField
          label={label}
          type="password"
          value={text}
          autoComplete="new-password"
          mono
          onChange={(value) => {
            setText(value)
            onChange(value || undefined)
          }}
          description={
            hasStoredSecret
              ? 'A value is set. Enter a new one to replace it.'
              : 'Write-only: it is never shown again.'
          }
        />
      )
    case 'number':
      return (
        <TextField
          label={label}
          type="number"
          value={text}
          error={error}
          onChange={(value) => {
            setText(value)
            const parsed = Number(value)
            const valid =
              value.trim() !== '' &&
              Number.isFinite(parsed) &&
              (!editor.integer || Number.isInteger(parsed))
            setError(valid ? undefined : editor.integer ? 'Enter a whole number' : 'Enter a number')
            onChange(valid ? parsed : undefined)
          }}
        />
      )
    case 'string':
      return (
        <TextField
          label={label}
          value={text}
          onChange={(value) => {
            setText(value)
            onChange(value)
          }}
        />
      )
    default:
      return (
        <TextField
          label={label}
          multiline
          rows={10}
          mono
          value={text}
          error={error}
          description="JSON. Arrays like the allowlist are edited here as a whole."
          onChange={(value) => {
            setText(value)
            const result = parseJson(value)
            setError(result.ok ? undefined : result.error)
            onChange(result.ok ? result.value : undefined)
          }}
        />
      )
  }
}
