import { useState } from 'react'

import type { EditorKind } from '../../lib/schema.ts'
import { Select, Switch, TextField } from '../../ui/index.ts'
import { StructuredEditor } from './SchemaField.tsx'

/**
 * Edits one setting value with the editor its schema calls for. Reports `undefined` through
 * `onChange` while the input cannot be turned into a value (invalid field, invalid JSON, empty
 * secret).
 */
export function ValueEditor({
  editor,
  schema,
  initial,
  onChange,
  label,
  hasStoredSecret,
}: {
  editor: EditorKind
  schema: unknown
  initial: unknown
  onChange: (value: unknown) => void
  label: string
  hasStoredSecret?: boolean
}) {
  const [text, setText] = useState(() =>
    typeof initial === 'string' || typeof initial === 'number' ? String(initial) : '',
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
        <StructuredEditor schema={schema} initial={initial} onChange={onChange} label={label} />
      )
  }
}
