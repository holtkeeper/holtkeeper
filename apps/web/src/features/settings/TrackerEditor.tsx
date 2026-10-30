import {
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { humanize, type JsonSchema } from '../../lib/schema-form.ts'
import { parseJson } from '../../lib/schema.ts'
import {
  PART_HINTS,
  PART_LISTS,
  type PartList,
  type TrackerLinks,
  type TrackerPart,
  type TrackerValue,
  isNormalizeStep,
  newPart,
  newTracker,
  normalizeTrackers,
  partId,
  partVariants,
  trackerLinks,
  trackerProblems,
} from '../../lib/trackers.ts'
import { Button, Notice, Segmented, Select, TagInput, TextField, useTheme } from '../../ui/index.ts'
import { Railed, RemoveButton } from './blocks.tsx'
import { SchemaForm } from './SchemaField.tsx'

type Variants = Record<PartList, Map<string, JsonSchema>>

const LIST_HINTS: Record<PartList, string> = {
  sources: 'Where entities appear. Each source tags what it finds with a role.',
  rules: 'What counts as a problem. Rules compare roles, e.g. definition against usage.',
  outputs: 'Where the overview and findings go after every run.',
}

let nextKey = 0
const freshKey = () => `t${++nextKey}`

interface Row {
  key: string
  tracker: TrackerValue
}

/**
 * Edits trackers as blocks: entity, sources, rules and outputs, with a map of which source roles
 * feed which rules and where findings go. Raw JSON is one toggle away. Reports `undefined` while a
 * tracker has a problem the server would reject.
 */
export function TrackerEditor({
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
  const [rows, setRows] = useState<Row[]>(() =>
    normalizeTrackers(initial).map((tracker) => ({ key: freshKey(), tracker })),
  )
  const [mode, setMode] = useState<'blocks' | 'json'>('blocks')
  const [text, setText] = useState('')
  const [jsonError, setJsonError] = useState<string>()
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(() => new Set())
  const variants = useMemo<Variants>(
    () => ({
      sources: partVariants(schema, 'sources'),
      rules: partVariants(schema, 'rules'),
      outputs: partVariants(schema, 'outputs'),
    }),
    [schema],
  )
  const trackers = useMemo(() => rows.map((row) => row.tracker), [rows])
  const problems = trackerProblems(trackers)
  const broken = mode === 'json' ? jsonError !== undefined : problems.size > 0 || invalid.size > 0

  useEffect(() => onChange(broken ? undefined : trackers), [onChange, broken, trackers])

  const reportInvalid = useCallback(
    (key: string, bad: boolean) =>
      setInvalid((previous) => {
        if (previous.has(key) === bad) return previous
        const next = new Set(previous)
        if (bad) next.add(key)
        else next.delete(key)
        return next
      }),
    [],
  )

  const move = (from: number, to: number) =>
    setRows((previous) => {
      const next = [...previous]
      const [moved] = next.splice(from, 1)
      if (moved) next.splice(to, 0, moved)
      return next
    })

  const switchTo = (next: 'blocks' | 'json') => {
    if (next === mode) return
    if (next === 'json') {
      setText(JSON.stringify(trackers, null, 2))
      setJsonError(undefined)
      setMode('json')
      return
    }
    const parsed = parseJson(text)
    if (!parsed.ok) return
    setRows(normalizeTrackers(parsed.value).map((tracker) => ({ key: freshKey(), tracker })))
    setInvalid(new Set())
    setMode('blocks')
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <Segmented
          aria-label="Editor"
          value={mode}
          onChange={switchTo}
          options={[
            { id: 'blocks', label: 'Blocks' },
            { id: 'json', label: 'JSON' },
          ]}
        />
      </div>
      {mode === 'json' ? (
        <TextField
          aria-label={label}
          multiline
          rows={18}
          mono
          value={text}
          error={jsonError}
          description="Fix any error to switch back to blocks."
          onChange={(next) => {
            setText(next)
            const result = parseJson(next)
            setJsonError(result.ok ? undefined : result.error)
          }}
        />
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-separator p-6 text-center text-sm text-muted">
              No trackers yet. Add one, then give it a source, a rule and an output.
            </p>
          ) : null}
          {rows.map((row, index) => (
            <TrackerBlock
              key={row.key}
              rowKey={row.key}
              index={index}
              count={rows.length}
              tracker={row.tracker}
              problems={problems.get(index) ?? []}
              variants={variants}
              root={schema}
              onChange={(tracker) =>
                setRows((previous) => previous.map((r, i) => (i === index ? { ...r, tracker } : r)))
              }
              onMove={(to) => move(index, to)}
              onRemove={() => setRows((previous) => previous.filter((_, i) => i !== index))}
              onInvalid={reportInvalid}
            />
          ))}
          <div>
            <Button
              variant="secondary"
              size="sm"
              onPress={() =>
                setRows((previous) => [
                  ...previous,
                  { key: freshKey(), tracker: newTracker(previous.map((r) => r.tracker.id)) },
                ])
              }
            >
              <Plus className="size-3.5" />
              Add tracker
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function TrackerBlock({
  rowKey,
  index,
  count,
  tracker,
  problems,
  variants,
  root,
  onChange,
  onMove,
  onRemove,
  onInvalid,
}: {
  rowKey: string
  index: number
  count: number
  tracker: TrackerValue
  problems: string[]
  variants: Variants
  root: unknown
  onChange: (tracker: TrackerValue) => void
  onMove: (to: number) => void
  onRemove: () => void
  onInvalid: (key: string, invalid: boolean) => void
}) {
  const keys = useRef<Record<PartList, string[]>>({ sources: [], rules: [], outputs: [] })
  for (const list of PART_LISTS) {
    while (keys.current[list].length < tracker[list].length) keys.current[list].push(freshKey())
  }
  const links = useMemo(() => trackerLinks(tracker, variants, root), [tracker, variants, root])
  const set = (patch: Partial<TrackerValue>) => onChange({ ...tracker, ...patch })
  const setList = (list: PartList, items: TrackerPart[], nextKeys: string[]) => {
    keys.current = { ...keys.current, [list]: nextKeys }
    set({ [list]: items })
  }

  return (
    <section
      aria-label={`Tracker ${tracker.name || index + 1}`}
      className="flex flex-col gap-4 rounded-2xl border border-separator bg-surface p-4 shadow-surface"
    >
      <header className="flex flex-wrap items-start gap-3">
        <span className="mt-2 grid size-6 shrink-0 place-items-center rounded-full bg-default text-xs font-semibold">
          {index + 1}
        </span>
        <TextField
          label="Name"
          value={tracker.name}
          className="min-w-48 flex-1"
          onChange={(name) => set({ name })}
        />
        <TextField
          label="Id"
          value={tracker.id}
          mono
          className="w-48"
          description="The tracker analyzer runs a tracker by id"
          onChange={(id) => set({ id })}
        />
        <div className="mt-7 flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="Move tracker up"
            isDisabled={index === 0}
            onPress={() => onMove(index - 1)}
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="Move tracker down"
            isDisabled={index === count - 1}
            onPress={() => onMove(index + 1)}
          >
            <ArrowDown className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="Remove tracker"
            onPress={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-[16rem_minmax(0,1fr)]">
        <TextField
          label="One entity is called"
          placeholder="Feature flag"
          value={tracker.entity.label}
          onChange={(entityLabel) => set({ entity: { ...tracker.entity, label: entityLabel } })}
        />
        <TagInput
          label="Key normalization"
          description="Steps in order, so different spellings meet: lower, upper, snake, kebab, camel, trim-prefix:<p>, trim-suffix:<s>"
          placeholder="snake, then Enter"
          suggestions={[
            'lower',
            'upper',
            'snake',
            'kebab',
            'camel',
            'trim-prefix:',
            'trim-suffix:',
          ]}
          validate={(step) => (isNormalizeStep(step) ? undefined : 'Unknown step')}
          values={tracker.entity.key.normalize}
          onChange={(normalize) => set({ entity: { ...tracker.entity, key: { normalize } } })}
        />
      </div>

      {problems.length ? (
        <Notice tone="danger" title="Fix before saving">
          {problems.join('. ')}
        </Notice>
      ) : null}

      <TrackerFlow links={links} />

      {PART_LISTS.map((list) => (
        <Railed key={list} rail={list} hint={LIST_HINTS[list]}>
          <div className="flex flex-col gap-2">
            {tracker[list].map((part, i) => {
              const key = keys.current[list][i] ?? String(i)
              return (
                <PartBlock
                  key={key}
                  invalidKey={`${rowKey}/${key}`}
                  id={partId(part, i, list)}
                  part={part}
                  variant={variants[list].get(part.kind)}
                  root={root}
                  onChange={(next) =>
                    setList(
                      list,
                      tracker[list].map((p, j) => (j === i ? next : p)),
                      keys.current[list],
                    )
                  }
                  onRemove={() =>
                    setList(
                      list,
                      tracker[list].filter((_, j) => j !== i),
                      keys.current[list].filter((_, j) => j !== i),
                    )
                  }
                  onInvalid={onInvalid}
                />
              )
            })}
            <Select
              aria-label={`Add ${list.slice(0, -1)}`}
              placeholder={`Add ${list.slice(0, -1)}…`}
              className="w-64"
              value={undefined}
              options={[...variants[list].keys()].map((kind) => ({
                id: kind,
                label: humanize(kind),
              }))}
              onChange={(kind) =>
                setList(
                  list,
                  [...tracker[list], newPart(kind, variants[list].get(kind), root)],
                  [...keys.current[list], freshKey()],
                )
              }
            />
          </div>
        </Railed>
      ))}
    </section>
  )
}

function PartBlock({
  invalidKey,
  id,
  part,
  variant,
  root,
  onChange,
  onRemove,
  onInvalid,
}: {
  invalidKey: string
  id: string
  part: TrackerPart
  variant: JsonSchema | undefined
  root: unknown
  onChange: (part: TrackerPart) => void
  onRemove: () => void
  onInvalid: (key: string, invalid: boolean) => void
}) {
  const reportInvalid = useCallback(
    (bad: boolean) => onInvalid(invalidKey, bad),
    [onInvalid, invalidKey],
  )
  useEffect(() => () => onInvalid(invalidKey, false), [onInvalid, invalidKey])
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-separator p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{humanize(part.kind)}</span>
        <span className="font-mono text-[11px] text-muted">{id}</span>
        <span className="truncate text-xs text-muted">{PART_HINTS[part.kind] ?? ''}</span>
        <span className="ml-auto">
          <RemoveButton label={`Remove ${id}`} onPress={onRemove} />
        </span>
      </div>
      {variant ? (
        <SchemaForm
          schema={variant}
          root={root}
          value={part}
          label={humanize(part.kind)}
          onInvalid={reportInvalid}
          onChange={(next) =>
            onChange({
              ...(typeof next === 'object' && next !== null ? next : {}),
              kind: part.kind,
            })
          }
        />
      ) : (
        <p className="text-xs text-muted">Options of this kind can be edited in JSON.</p>
      )}
    </div>
  )
}

type FlowData = {
  title: string
  detail: string
  tone: 'default' | 'warning' | 'danger'
  inbound: boolean
  outbound: boolean
}
type FlowNode = Node<FlowData, 'part'>

const TONE_BORDER = { default: 'var(--border)', warning: 'var(--warning)', danger: 'var(--danger)' }

function PartNode({ data }: NodeProps<FlowNode>) {
  return (
    <div
      className="flex h-full w-full flex-col justify-center overflow-hidden rounded-xl border bg-surface px-3 shadow-surface"
      style={{ borderColor: TONE_BORDER[data.tone] }}
      title={`${data.title}: ${data.detail}`}
    >
      {data.inbound ? (
        <Handle
          type="target"
          position={Position.Left}
          className="!size-1.5 !border-0 !bg-border-tertiary"
        />
      ) : null}
      <span className="truncate font-mono text-[12px] font-medium">{data.title}</span>
      <span className="truncate text-[10px] text-muted">{data.detail}</span>
      {data.outbound ? (
        <Handle
          type="source"
          position={Position.Right}
          className="!size-1.5 !border-0 !bg-border-tertiary"
        />
      ) : null}
    </div>
  )
}

const nodeTypes = { part: PartNode }
const COLUMN_X = [0, 300, 600]
const ROW_HEIGHT = 64
const NODE = { width: 220, height: 48 }

const edge = (source: string, target: string, label?: string): Edge => ({
  id: `${source}->${target}`,
  source,
  target,
  ...(label ? { label } : {}),
  markerEnd: { type: MarkerType.ArrowClosed },
  style: { stroke: 'var(--border-tertiary)' },
  labelStyle: { fontSize: 10 },
})

function flowGraph(links: TrackerLinks): { nodes: FlowNode[]; edges: Edge[] } {
  const middle = links.rules.length > 0
  const node = (id: string, column: number, row: number, data: FlowData): FlowNode => ({
    id,
    type: 'part',
    position: {
      x: COLUMN_X[middle ? column : column === 2 ? 1 : column] ?? 0,
      y: row * ROW_HEIGHT,
    },
    data,
    ...NODE,
    draggable: false,
    selectable: false,
  })
  const nodes: FlowNode[] = [
    ...links.sources.map((source, i) =>
      node(`s:${source.id}`, 0, i, {
        title: source.id,
        detail: source.role.length ? `role ${source.role.join(', ')}` : 'no role yet',
        tone: links.unread.includes(source.id) ? 'warning' : 'default',
        inbound: false,
        outbound: true,
      }),
    ),
    ...links.rules.map((rule, i) =>
      node(`r:${rule.id}`, 1, i, {
        title: rule.id,
        detail: rule.missing.length
          ? `no source for ${rule.missing.join(', ')}`
          : `reads ${rule.reads.join(', ')}`,
        tone: rule.missing.length ? 'danger' : 'default',
        inbound: true,
        outbound: true,
      }),
    ),
    ...links.outputs.map((output, i) =>
      node(`o:${output.id}`, 2, i, {
        title: output.id,
        detail: humanize(output.kind),
        tone: 'default',
        inbound: true,
        outbound: false,
      }),
    ),
  ]
  const edges: Edge[] = middle
    ? [
        ...links.rules.flatMap((rule) =>
          links.sources
            .filter((source) => source.role.some((role) => rule.reads.includes(role)))
            .map((source) =>
              edge(
                `s:${source.id}`,
                `r:${rule.id}`,
                source.role.filter((role) => rule.reads.includes(role)).join(', '),
              ),
            ),
        ),
        ...links.rules.flatMap((rule) =>
          links.outputs.map((output) => edge(`r:${rule.id}`, `o:${output.id}`)),
        ),
      ]
    : links.sources.flatMap((source) =>
        links.outputs.map((output) => edge(`s:${source.id}`, `o:${output.id}`)),
      )
  return { nodes, edges }
}

/** A read-only map of the tracker: sources by role → rules that read them → outputs. */
function TrackerFlow({ links }: { links: TrackerLinks }) {
  const { theme } = useTheme()
  const { nodes, edges } = useMemo(() => flowGraph(links), [links])
  const rows = Math.max(links.sources.length, links.rules.length, links.outputs.length, 1)
  if (nodes.length === 0) return null
  const missing = links.rules.flatMap((rule) =>
    rule.missing.map((role) => `${rule.id} needs ${role}`),
  )
  return (
    <div className="flex flex-col gap-2">
      <div
        className="overflow-hidden rounded-xl border border-border"
        style={{ height: rows * ROW_HEIGHT + 48 }}
        role="figure"
        aria-label={`Tracker map: ${links.sources.length} sources, ${links.rules.length} rules, ${links.outputs.length} outputs`}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        />
      </div>
      {missing.length || links.unread.length ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {missing.map((line) => (
            <li key={line} className="text-danger">
              {line}: no source has that role, so the rule never finds anything.
            </li>
          ))}
          {links.unread.map((id) => (
            <li key={id} className="text-warning">
              {id}: no rule reads its role; it only shows up in the overview.
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
