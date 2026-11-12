import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useId, useState } from 'react'

/**
 * Editable list of short strings: type and press Enter (or comma) to add, Backspace on an empty
 * input removes the last one. `validate` returns an error message to reject a value. `isDisabled`
 * shows the values without letting anyone change them.
 */
export function TagInput({
  label,
  values,
  onChange,
  placeholder,
  validate,
  suggestions = [],
  description,
  hideLabel,
  isDisabled = false,
  labelOf,
}: {
  label: ReactNode
  values: readonly string[]
  onChange: (values: string[]) => void
  placeholder?: string
  validate?: (value: string) => string | undefined
  suggestions?: readonly string[]
  description?: ReactNode
  /** Keeps the label for screen readers only, for inputs labelled by their surroundings. */
  hideLabel?: boolean
  isDisabled?: boolean
  /** What people read for a value, e.g. a group's title; shown with the value as secondary text. */
  labelOf?: (value: string) => string
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()
  const id = useId()
  const listId = `${id}-suggestions`

  const add = (raw: string) => {
    const value = raw.trim()
    if (!value) return
    const problem = validate?.(value)
    if (problem) {
      setError(problem)
      return
    }
    if (!values.includes(value)) onChange([...values, value])
    setDraft('')
    setError(undefined)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-sm font-medium'}>
        {label}
      </label>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border border-field-border bg-field px-2 py-1.5 shadow-field focus-within:ring-2 focus-within:ring-focus">
        <AnimatePresence initial={false}>
          {values.map((value) => (
            <motion.span
              key={value}
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="inline-flex items-center gap-1 rounded-lg bg-default px-2 py-0.5 font-mono text-xs"
            >
              {labelOf && labelOf(value) !== value ? (
                <>
                  <span className="font-sans">{labelOf(value)}</span>
                  <span className="text-muted">{value}</span>
                </>
              ) : (
                value
              )}
              {isDisabled ? null : (
                <button
                  type="button"
                  aria-label={`Remove ${value}`}
                  className="rounded p-0.5 text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus"
                  onClick={() => onChange(values.filter((v) => v !== value))}
                >
                  <X className="size-3" />
                </button>
              )}
            </motion.span>
          ))}
        </AnimatePresence>
        <input
          id={id}
          value={draft}
          disabled={isDisabled}
          list={suggestions.length ? listId : undefined}
          placeholder={values.length ? '' : placeholder}
          aria-invalid={error !== undefined}
          className="min-w-32 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-field-placeholder"
          onChange={(event) => {
            setDraft(event.target.value)
            setError(undefined)
          }}
          onBlur={() => !isDisabled && add(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              add(draft)
            } else if (event.key === 'Backspace' && !draft && values.length) {
              onChange(values.slice(0, -1))
            }
          }}
        />
        {suggestions.length ? (
          <datalist id={listId}>
            {suggestions
              .filter((s) => !values.includes(s))
              .map((s) => (
                <option key={s} value={s} label={labelOf?.(s)} />
              ))}
          </datalist>
        ) : null}
      </div>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : description ? (
        <span className="text-xs text-muted">{description}</span>
      ) : null}
    </div>
  )
}
