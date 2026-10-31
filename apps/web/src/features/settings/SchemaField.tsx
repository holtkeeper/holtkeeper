import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'

import {
  type FieldNode,
  type JsonSchema,
  type Property,
  type Variant,
  describeField,
  describedAs,
  hasForm,
  initialValue,
  parseNumber,
  propertyLabel,
  resolve,
  stringError,
  variantIndex,
} from '../../lib/schema-form.ts'
import { parseJson, previewValue } from '../../lib/schema.ts'
import {
  Button,
  MultiToggle,
  Segmented,
  Select,
  Switch,
  TagInput,
  TextField,
  Tooltip,
} from '../../ui/index.ts'
import { CredentialPicker, CredentialsPicker } from './CredentialPicker.tsx'

type Report = (path: string, invalid: boolean) => void

const InvalidContext = createContext<Report>(() => {})

function useInvalid(path: string, error: string | undefined) {
  const report = useContext(InvalidContext)
  const invalid = error !== undefined
  useEffect(() => {
    report(path, invalid)
    return () => report(path, false)
  }, [report, path, invalid])
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface FieldProps {
  schema: unknown
  root: unknown
  value: unknown
  onChange: (value: unknown) => void
  label: string
  path: string
  depth: number
  hideLabel?: boolean
}

/** Edits a JSON value as a form built from its JSON Schema, with the raw JSON one toggle away. */
export function StructuredEditor({
  schema,
  initial,
  onChange,
  label,
}: {
  schema: unknown
  initial: unknown
  onChange: (value: unknown) => void
  label: string
}) {
  const form = hasForm(schema)
  const [mode, setMode] = useState<'form' | 'json'>(form ? 'form' : 'json')
  const [value, setValue] = useState(initial)
  const [text, setText] = useState(() => JSON.stringify(initial ?? null, null, 2))
  const [jsonError, setJsonError] = useState<string>()
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(() => new Set())

  const report = useCallback<Report>(
    (path, bad) =>
      setInvalid((previous) => {
        if (previous.has(path) === bad) return previous
        const next = new Set(previous)
        if (bad) next.add(path)
        else next.delete(path)
        return next
      }),
    [],
  )

  const broken = mode === 'json' ? jsonError !== undefined : invalid.size > 0
  useEffect(() => onChange(broken ? undefined : value), [onChange, broken, value])

  const switchTo = (next: 'form' | 'json') => {
    if (next === mode || (next === 'form' && jsonError !== undefined)) return
    if (next === 'json') {
      setText(JSON.stringify(value ?? null, null, 2))
      setJsonError(undefined)
    }
    setMode(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {form ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">{label}</span>
          <Segmented
            aria-label="Editor"
            value={mode}
            onChange={switchTo}
            options={[
              { id: 'form', label: 'Form' },
              { id: 'json', label: 'JSON' },
            ]}
          />
        </div>
      ) : null}
      {mode === 'form' ? (
        <InvalidContext value={report}>
          <SchemaField
            schema={schema}
            root={schema}
            value={value}
            onChange={setValue}
            label={label}
            path=""
            depth={0}
            hideLabel
          />
        </InvalidContext>
      ) : (
        <TextField
          label={form ? undefined : label}
          aria-label={label}
          multiline
          rows={14}
          mono
          value={text}
          error={jsonError}
          description={form ? 'Fix any error to switch back to the form.' : 'JSON'}
          onChange={(next) => {
            setText(next)
            const result = parseJson(next)
            setJsonError(result.ok ? undefined : result.error)
            if (result.ok) setValue(result.value)
          }}
        />
      )}
    </div>
  )
}

/**
 * A form for one value of a larger schema (`root` resolves its refs), without the JSON toggle.
 * `onInvalid` tells whether any field currently holds input that is not a valid value.
 */
export function SchemaForm({
  schema,
  root,
  value,
  onChange,
  onInvalid,
  label,
}: {
  schema: unknown
  root: unknown
  value: unknown
  onChange: (value: unknown) => void
  onInvalid: (invalid: boolean) => void
  label: string
}) {
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(() => new Set())
  const report = useCallback<Report>(
    (path, bad) =>
      setInvalid((previous) => {
        if (previous.has(path) === bad) return previous
        const next = new Set(previous)
        if (bad) next.add(path)
        else next.delete(path)
        return next
      }),
    [],
  )
  const broken = invalid.size > 0
  useEffect(() => onInvalid(broken), [onInvalid, broken])
  return (
    <InvalidContext value={report}>
      <SchemaField
        schema={schema}
        root={root}
        value={value}
        onChange={onChange}
        label={label}
        path=""
        depth={0}
        hideLabel
      />
    </InvalidContext>
  )
}

function SchemaField(props: FieldProps) {
  const node = describeField(props.schema, props.root)
  switch (node.kind) {
    case 'fixed':
      return null
    case 'boolean':
      return (
        <Switch
          label={props.label}
          isSelected={props.value === true}
          onChange={props.onChange}
          description={describedAs(props.schema, props.root)}
        />
      )
    case 'enum':
      return (
        <Select
          {...(props.hideLabel ? {} : { label: props.label })}
          aria-label={props.label}
          options={node.options.map((option) => ({ id: option, label: option }))}
          value={typeof props.value === 'string' ? props.value : undefined}
          onChange={props.onChange}
        />
      )
    case 'string':
      return <StringField {...props} node={node} />
    case 'number':
      return <NumberField {...props} node={node} />
    case 'credential':
      return <CredentialField {...props} of={node.of} />
    case 'credentials':
      return (
        <CredentialsPicker
          of={node.of}
          value={props.value}
          onChange={props.onChange}
          label={props.label}
        />
      )
    case 'tags':
      return <TagsField {...props} node={node} />
    case 'multi':
      return (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{props.label}</span>
          <MultiToggle
            aria-label={props.label}
            options={node.options.map((option) => ({ id: option, label: option }))}
            value={
              Array.isArray(props.value) ? props.value.filter((v) => typeof v === 'string') : []
            }
            onChange={props.onChange}
          />
        </div>
      )
    case 'object':
      return <ObjectField {...props} properties={node.properties} />
    case 'record':
      return <RecordField {...props} node={node} />
    case 'list':
      return <ListField {...props} item={node.item} />
    case 'variants':
      return (
        <VariantsField
          {...props}
          variants={node.variants}
          discriminated={node.discriminator !== undefined}
        />
      )
    default:
      return <JsonField {...props} />
  }
}

function Group({
  label,
  depth,
  hideLabel,
  children,
}: {
  label: string
  depth: number
  hideLabel?: boolean | undefined
  children: React.ReactNode
}) {
  if (depth === 0) {
    return (
      <div className="flex flex-col gap-3">
        {hideLabel ? null : <span className="text-sm font-medium">{label}</span>}
        {children}
      </div>
    )
  }
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-xl border border-separator p-3">
      {hideLabel ? null : <legend className="px-1 text-sm font-medium">{label}</legend>}
      {children}
    </fieldset>
  )
}

function StringField({
  node,
  ...props
}: FieldProps & { node: Extract<FieldNode, { kind: 'string' }> }) {
  const text = typeof props.value === 'string' ? props.value : ''
  const error = stringError(node, text)
  useInvalid(props.path, error)
  return (
    <TextField
      {...(props.hideLabel ? {} : { label: props.label })}
      aria-label={props.label}
      value={text}
      type={node.format === 'date' ? 'date' : node.format === 'uri' ? 'url' : 'text'}
      error={error}
      description={describedAs(props.schema, props.root)}
      onChange={props.onChange}
    />
  )
}

function CredentialField({ of, ...props }: FieldProps & { of: string }) {
  useInvalid(
    props.path,
    typeof props.value === 'string' && props.value !== '' ? undefined : 'Required',
  )
  return (
    <CredentialPicker of={of} value={props.value} onChange={props.onChange} label={props.label} />
  )
}

function NumberField({
  node,
  ...props
}: FieldProps & { node: Extract<FieldNode, { kind: 'number' }> }) {
  const [text, setText] = useState(() =>
    typeof props.value === 'number' ? String(props.value) : '',
  )
  const parsed = parseNumber(node, text)
  const error = parsed.ok ? undefined : parsed.error
  useInvalid(props.path, error)
  return (
    <TextField
      {...(props.hideLabel ? {} : { label: props.label })}
      aria-label={props.label}
      type="number"
      value={text}
      error={error}
      description={describedAs(props.schema, props.root)}
      onChange={(next) => {
        setText(next)
        const result = parseNumber(node, next)
        if (result.ok) props.onChange(result.value)
      }}
    />
  )
}

function TagsField({
  node,
  ...props
}: FieldProps & { node: Extract<FieldNode, { kind: 'tags' }> }) {
  const items = Array.isArray(props.value) ? props.value : []
  const item = node.item
  return (
    <TagInput
      label={props.label}
      values={items.map(String)}
      placeholder="Type and press Enter"
      description={describedAs(props.schema, props.root)}
      validate={(text) =>
        item.kind === 'number'
          ? (() => {
              const result = parseNumber(item, text)
              return result.ok ? undefined : result.error
            })()
          : item.kind === 'string'
            ? stringError(item, text)
            : undefined
      }
      onChange={(values) => props.onChange(item.kind === 'number' ? values.map(Number) : values)}
    />
  )
}

function ObjectField({ properties, ...props }: FieldProps & { properties: Property[] }) {
  const value = isObject(props.value) ? props.value : {}
  const shown = properties.filter((p) => describeField(p.schema, props.root).kind !== 'fixed')
  const isSet = (p: Property) => p.required || p.name in value
  const unset = shown.filter((p) => !isSet(p))
  const update = (name: string, next: unknown) => props.onChange({ ...value, [name]: next })
  const remove = (name: string) =>
    props.onChange(Object.fromEntries(Object.entries(value).filter(([key]) => key !== name)))

  return (
    <Group label={props.label} depth={props.depth} hideLabel={props.hideLabel}>
      {shown.filter(isSet).map((property) => {
        const label = propertyLabel(property, props.root)
        const field = (
          <SchemaField
            schema={property.schema}
            root={props.root}
            value={value[property.name]}
            onChange={(next) => update(property.name, next)}
            label={label}
            path={`${props.path}/${property.name}`}
            depth={props.depth + 1}
          />
        )
        if (property.required) return <div key={property.name}>{field}</div>
        return (
          <div key={property.name} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">{field}</div>
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={`Unset ${label}`}
              onPress={() => remove(property.name)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )
      })}
      {unset.length ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-1.5">
            {unset.map((property) => {
              const label = propertyLabel(property, props.root)
              const fallback = resolve(property.schema, props.root).default
              const button = (
                <Button
                  key={property.name}
                  variant="secondary"
                  size="sm"
                  onPress={() => update(property.name, initialValue(property.schema, props.root))}
                >
                  <Plus className="size-3.5" />
                  {label}
                </Button>
              )
              return fallback === undefined ? (
                button
              ) : (
                <Tooltip key={property.name} content={`Default: ${previewValue(fallback, false)}`}>
                  {button}
                </Tooltip>
              )
            })}
          </div>
          <span className="text-xs text-muted">Options that are not set keep their defaults.</span>
        </div>
      ) : null}
      {shown.length === 0 ? <span className="text-sm text-muted">No options.</span> : null}
    </Group>
  )
}

function RecordField({
  node,
  ...props
}: FieldProps & { node: Extract<FieldNode, { kind: 'record' }> }) {
  const value = isObject(props.value) ? props.value : {}
  const [draft, setDraft] = useState('')
  const key = draft.trim()
  const error = key === '' ? undefined : key in value ? 'Already added' : stringError(node.key, key)

  const add = () => {
    if (key === '' || error) return
    props.onChange({ ...value, [key]: initialValue(node.value, props.root) })
    setDraft('')
  }

  return (
    <Group label={props.label} depth={props.depth} hideLabel={props.hideLabel}>
      {Object.entries(value).map(([name, entry]) => (
        <div key={name} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <SchemaField
              schema={node.value}
              root={props.root}
              value={entry}
              onChange={(next) => props.onChange({ ...value, [name]: next })}
              label={name}
              path={`${props.path}/${name}`}
              depth={props.depth + 1}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={`Remove ${name}`}
            onPress={() =>
              props.onChange(Object.fromEntries(Object.entries(value).filter(([k]) => k !== name)))
            }
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex items-start gap-2">
        <TextField
          aria-label={`New ${props.label} key`}
          placeholder="New key"
          value={draft}
          mono
          error={error}
          className="min-w-0 flex-1"
          onChange={setDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          onPress={add}
          isDisabled={key === '' || error !== undefined}
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>
    </Group>
  )
}

function ListField({ item, ...props }: FieldProps & { item: JsonSchema }) {
  const items = Array.isArray(props.value) ? props.value : []
  const move = (from: number, to: number) => {
    const next = [...items]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    props.onChange(next)
  }

  return (
    <Group label={props.label} depth={props.depth} hideLabel={props.hideLabel}>
      {items.map((entry, index) => (
        // oxlint-disable-next-line react/no-array-index-key
        <div key={index} className="flex flex-col gap-2 rounded-xl border border-separator p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted">#{index + 1}</span>
            <span className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={`Move item ${index + 1} up`}
                isDisabled={index === 0}
                onPress={() => move(index, index - 1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={`Move item ${index + 1} down`}
                isDisabled={index === items.length - 1}
                onPress={() => move(index, index + 1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={`Remove item ${index + 1}`}
                onPress={() => props.onChange(items.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </span>
          </div>
          <SchemaField
            schema={item}
            root={props.root}
            value={entry}
            onChange={(next) => props.onChange(items.map((v, i) => (i === index ? next : v)))}
            label={`${props.label} ${index + 1}`}
            path={`${props.path}/${index}`}
            depth={0}
            hideLabel
          />
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          size="sm"
          onPress={() => props.onChange([...items, initialValue(item, props.root)])}
        >
          <Plus className="size-3.5" />
          Add item
        </Button>
      </div>
    </Group>
  )
}

function VariantsField({
  variants,
  discriminated,
  ...props
}: FieldProps & { variants: Variant[]; discriminated: boolean }) {
  const index = variantIndex(variants, props.value, props.root)
  const variant = variants[index]
  const compact =
    !discriminated && variants.length <= 4 && variants.every((v) => v.label.length <= 12)
  const pick = (next: number) => {
    const chosen = variants[next]
    if (chosen && next !== index) props.onChange(initialValue(chosen.schema, props.root))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{props.label}</span>
        {compact ? (
          <Segmented
            aria-label={`${props.label} type`}
            value={String(index)}
            onChange={(id) => pick(Number(id))}
            options={variants.map((v, i) => ({ id: String(i), label: v.label }))}
          />
        ) : (
          <Select
            aria-label={discriminated ? `${props.label} kind` : `${props.label} type`}
            className="min-w-40"
            options={variants.map((v, i) => ({ id: String(i), label: v.label }))}
            value={String(index)}
            onChange={(id) => pick(Number(id))}
          />
        )}
      </div>
      {variant ? (
        <SchemaField
          key={index}
          schema={variant.schema}
          root={props.root}
          value={props.value}
          onChange={props.onChange}
          label={props.label}
          path={`${props.path}/${index}`}
          depth={props.depth}
          hideLabel
        />
      ) : null}
    </div>
  )
}

function JsonField(props: FieldProps) {
  const [text, setText] = useState(() => JSON.stringify(props.value ?? null, null, 2))
  const parsed = parseJson(text)
  const error = parsed.ok ? undefined : parsed.error
  useInvalid(props.path, error)
  return (
    <TextField
      {...(props.hideLabel ? {} : { label: props.label })}
      aria-label={props.label}
      multiline
      rows={4}
      mono
      value={text}
      error={error}
      description={describedAs(props.schema, props.root) ?? 'JSON'}
      onChange={(next) => {
        setText(next)
        const result = parseJson(next)
        if (result.ok) props.onChange(result.value)
      }}
    />
  )
}
