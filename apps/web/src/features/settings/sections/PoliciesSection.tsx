import type {
  CommitConventionsCheckResult,
  SettingDefinitionView,
  SettingList,
  SettingView,
  UnknownSettingKeyView,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Plus, RotateCcw, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../../api/client.ts'
import { useGroupNames, useGroupTitles, useRepos, useSettings } from '../../../api/queries.ts'
import { useCheckCommitConventions, useSavePolicyDraft } from '../../../api/settings-analyzers.ts'
import { canInGroup } from '../../../lib/access.ts'
import { analyzerOptions, analyzersOffValue, readAnalyzersOff } from '../../../lib/analyzers-off.ts'
import { isoDay } from '../../../lib/format.ts'
import {
  type AllowlistRow,
  type PolicyDraft,
  type PolicyFocus,
  allowlistRowProblem,
  allowlistRows,
  draftChanges,
  draftCount,
  draftValue,
  focusEntry,
  focusUnknownKeys,
  listOf,
  recordOf,
  withEdit,
  withReset,
} from '../../../lib/policy-draft.ts'
import { editorFor } from '../../../lib/schema.ts'
import { definitionsOf, settingAnchor } from '../../../lib/settings-sections.ts'
import {
  Button,
  EmptyState,
  ErrorState,
  Notice,
  Placeholder,
  MultiToggle,
  Segmented,
  Select,
  Switch,
  Table,
  Tag,
  TagInput,
  Td,
  TextField,
  Th,
  Tr,
  notify,
} from '../../../ui/index.ts'
import { useSession } from '../../shell/session.ts'
import { PresetPicker } from '../PresetPicker.tsx'
import { UnknownKeys } from '../UnknownKeys.tsx'
import { ValueEditor } from '../ValueEditor.tsx'

const LICENSES = 'analyzers.licenses'
const TESTS = 'repo.tests'
const ANALYZERS_OFF = 'repo.analyzers'
const MR_COMMENTS = 'mergeRequests.comments'
const ALLOWLIST = 'audit.allowlist'
const ALLOWLIST_RULES = 'audit.allowlistPolicy'
const KNOWLEDGE = 'knowledge.autoAccept'
const LEARNINGS = 'learnings.autoAccept'
const GUIDE = 'guide.autoAccept'

/** What every policy card gets: the value at the focus and how to change it. */
interface Bound {
  definition: SettingDefinitionView
  value: unknown
  inherited: boolean
  edited: boolean
  writable: boolean
  onChange: (value: unknown) => void
  onReset: () => void
}

function PolicyCard({
  id,
  title,
  bound,
  focusLabel,
  page,
  unknownKeys,
  children,
}: {
  id: string
  title: string
  bound: Pick<Bound, 'inherited' | 'edited' | 'writable' | 'onReset'>
  focusLabel: string
  page?: { label: string; to: string }
  /** Keys the stored entries behind the card carry but nothing reads. */
  unknownKeys?: readonly UnknownSettingKeyView[]
  children: ReactNode
}) {
  return (
    <section
      id={id}
      className="flex scroll-mt-4 flex-col gap-3 rounded-xl border border-line bg-panel px-4 py-3.5"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        <Tag>{bound.inherited ? `Inherited by ${focusLabel}` : focusLabel}</Tag>
        {bound.edited ? <Tag tone="accent">Changed</Tag> : null}
        <span className="ml-auto flex items-center gap-1">
          {bound.writable && !bound.inherited ? (
            <Button size="sm" variant="ghost" onPress={bound.onReset}>
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
          ) : null}
          {page ? (
            <Link to={page.to} className="text-xs text-muted hover:text-foreground">
              Open {page.label}
            </Link>
          ) : null}
        </span>
      </header>
      <UnknownKeys keys={unknownKeys} />
      {children}
    </section>
  )
}

function ListColumn({
  label,
  hint,
  values,
  writable,
  onChange,
}: {
  label: string
  hint: string
  values: readonly string[]
  writable: boolean
  onChange: (values: string[]) => void
}) {
  return (
    <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1.5">
      <div className="flex items-baseline gap-1.5 text-xs">
        <span className="font-semibold">{label}</span>
        <span className="tabular text-muted">{values.length}</span>
        <span className="text-muted">· {hint}</span>
      </div>
      {writable ? (
        <TagInput
          label={label}
          hideLabel
          values={values}
          onChange={onChange}
          placeholder="MIT, GPL-*"
        />
      ) : (
        <div className="flex flex-wrap gap-1">
          {values.map((value) => (
            <Tag key={value} mono>
              {value}
            </Tag>
          ))}
        </div>
      )}
    </div>
  )
}

interface ExceptionRow {
  package: string
  version?: string
  license?: string
  reason: string
  approvedBy?: string
  expires?: string
}

const textOf = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

const exceptionRows = (value: unknown): ExceptionRow[] => {
  const list = recordOf(value).exceptions
  if (!Array.isArray(list)) return []
  return list.flatMap((item): ExceptionRow[] => {
    const record = recordOf(item)
    const name = textOf(record.package)
    const reason = textOf(record.reason)
    if (!name || !reason) return []
    const version = textOf(record.version)
    const license = textOf(record.license)
    const approvedBy = textOf(record.approvedBy)
    const expires = textOf(record.expires)
    return [
      {
        package: name,
        reason,
        ...(version && { version }),
        ...(license && { license }),
        ...(approvedBy && { approvedBy }),
        ...(expires && { expires }),
      },
    ]
  })
}

function ExceptionForm({ author, onAdd }: { author: string; onAdd: (row: ExceptionRow) => void }) {
  const [row, setRow] = useState({ package: '', version: '', license: '', reason: '', expires: '' })
  const set = (field: keyof typeof row) => (value: string) => setRow({ ...row, [field]: value })
  const ready = row.package.trim() && row.reason.trim()
  return (
    <div className="flex flex-wrap items-end gap-2">
      <TextField
        label="Package"
        value={row.package}
        onChange={set('package')}
        mono
        className="w-40"
      />
      <TextField
        label="Version"
        value={row.version}
        onChange={set('version')}
        mono
        className="w-24"
      />
      <TextField
        label="License"
        value={row.license}
        onChange={set('license')}
        mono
        className="w-32"
      />
      <TextField
        label="Reason"
        value={row.reason}
        onChange={set('reason')}
        className="min-w-48 flex-1"
      />
      <TextField
        label="Until"
        type="date"
        value={row.expires}
        onChange={set('expires')}
        className="w-36"
      />
      <Button
        size="sm"
        isDisabled={!ready}
        onPress={() => {
          onAdd({
            package: row.package.trim(),
            reason: row.reason.trim(),
            approvedBy: author,
            ...(row.version.trim() && { version: row.version.trim() }),
            ...(row.license.trim() && { license: row.license.trim() }),
            ...(row.expires && { expires: row.expires }),
          })
          setRow({ package: '', version: '', license: '', reason: '', expires: '' })
        }}
      >
        <Plus className="size-3.5" />
        Add exception
      </Button>
    </div>
  )
}

function LicensePolicy({ bound, author }: { bound: Bound; author: string }) {
  const value = recordOf(bound.value)
  const set = (field: string, next: unknown) => bound.onChange({ ...value, [field]: next })
  const exceptions = exceptionRows(value)
  const { writable } = bound
  return (
    <>
      {bound.definition.presets?.length && writable ? (
        <div className="max-w-sm">
          <PresetPicker
            presets={bound.definition.presets}
            value={bound.value}
            onApply={bound.onChange}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-4">
        <ListColumn
          label="Allowed"
          hint="pass without a look"
          values={listOf(value, 'allow')}
          writable={writable}
          onChange={(next) => set('allow', next)}
        />
        <ListColumn
          label="Needs review"
          hint="someone signs off"
          values={listOf(value, 'review')}
          writable={writable}
          onChange={(next) => set('review', next)}
        />
        <ListColumn
          label="Denied"
          hint="a violation"
          values={listOf(value, 'deny')}
          writable={writable}
          onChange={(next) => set('deny', next)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
        <span className="flex items-center gap-2">
          Unknown or missing license counts as
          <Segmented
            aria-label="Unknown licenses"
            options={[
              { id: 'warn', label: 'Needs review' },
              { id: 'violation', label: 'Denied' },
            ]}
            value={value.unknown === 'violation' ? 'violation' : 'warn'}
            isDisabled={!writable}
            onChange={(next) => set('unknown', next)}
          />
        </span>
        <span className="flex items-center gap-2">
          Dev-only dependencies
          <Segmented
            aria-label="Dev-only dependencies"
            options={[
              { id: 'check', label: 'Checked too' },
              { id: 'ignore', label: 'Ignored' },
            ]}
            value={value.devDependencies === 'ignore' ? 'ignore' : 'check'}
            isDisabled={!writable}
            onChange={(next) => set('devDependencies', next)}
          />
        </span>
        <Switch
          label="The repository needs its own license file"
          isSelected={value.requireProjectLicense === true}
          isDisabled={!writable}
          onChange={(next) => set('requireProjectLicense', next)}
        />
      </div>
      <TagInput
        label="Ignored packages"
        description="Package names, * allowed; their licenses are not judged."
        values={listOf(value, 'ignore')}
        isDisabled={!writable}
        onChange={(next) => set('ignore', next)}
      />
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold">Exceptions</h3>
        {exceptions.length ? (
          <Table label="License exceptions">
            <thead>
              <tr>
                <Th>Package</Th>
                <Th>License</Th>
                <Th>Reason</Th>
                <Th>Approved</Th>
                {writable ? <Th align="right">Actions</Th> : null}
              </tr>
            </thead>
            <tbody>
              {exceptions.map((exception, index) => (
                <Tr key={`${exception.package}@${exception.version ?? ''}#${index}`}>
                  <Td>
                    <span className="mono">
                      {exception.package}
                      {exception.version ? ` ${exception.version}` : ''}
                    </span>
                  </Td>
                  <Td>
                    <span className="mono text-muted">{exception.license ?? 'any'}</span>
                  </Td>
                  <Td>{exception.reason}</Td>
                  <Td>
                    <span className="text-xs text-muted">
                      {exception.approvedBy ?? '—'}
                      {exception.expires ? ` · until ${exception.expires}` : ''}
                    </span>
                  </Td>
                  {writable ? (
                    <Td align="right">
                      <Button
                        size="sm"
                        variant="ghost"
                        isIconOnly
                        aria-label={`Remove the exception for ${exception.package}`}
                        onPress={() =>
                          set(
                            'exceptions',
                            exceptions.filter((_, other) => other !== index),
                          )
                        }
                      >
                        <X className="size-3.5" />
                      </Button>
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-xs text-muted">
            No exceptions. A package an exception names passes with its reason until the date runs
            out.
          </p>
        )}
        {writable ? (
          <ExceptionForm author={author} onAdd={(row) => set('exceptions', [...exceptions, row])} />
        ) : null}
      </div>
      <p className="text-xs text-muted">
        Changes apply on the next license scan of each repository.
      </p>
    </>
  )
}

function AllowlistEntryForm({ onAdd }: { onAdd: (row: AllowlistRow) => void }) {
  const [row, setRow] = useState({ id: '', package: '', reason: '', expires: '' })
  const set = (field: keyof typeof row) => (value: string) => setRow({ ...row, [field]: value })
  return (
    <div className="flex flex-wrap items-end gap-2">
      <TextField label="Advisory" value={row.id} onChange={set('id')} mono className="w-40" />
      <TextField
        label="Package"
        value={row.package}
        onChange={set('package')}
        mono
        className="w-36"
      />
      <TextField
        label="Reason"
        value={row.reason}
        onChange={set('reason')}
        className="min-w-48 flex-1"
      />
      <TextField
        label="Expires"
        type="date"
        value={row.expires}
        onChange={set('expires')}
        className="w-36"
      />
      <Button
        size="sm"
        isDisabled={!row.id.trim()}
        onPress={() => {
          onAdd({
            id: row.id.trim(),
            reason: row.reason.trim(),
            ...(row.package.trim() && { package: row.package.trim() }),
            ...(row.expires && { expires: row.expires }),
          })
          setRow({ id: '', package: '', reason: '', expires: '' })
        }}
      >
        <Plus className="size-3.5" />
        Add entry
      </Button>
    </div>
  )
}

const addDays = (day: string, days: number) =>
  new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10)

function SecurityAllowlist({
  rules,
  list,
  stored,
  today,
}: {
  rules: Bound
  list: Bound
  stored: readonly AllowlistRow[]
  today: string
}) {
  const policy = recordOf(rules.value)
  const maxDays = typeof policy.maxDays === 'number' ? policy.maxDays : undefined
  const requireReason = policy.requireReason !== false
  const rows = allowlistRows(list.value)
  const changed = (row: AllowlistRow) =>
    !stored.some(
      (old) =>
        old.id === row.id &&
        old.package === row.package &&
        old.reason === row.reason &&
        old.expires === row.expires,
    )
  const writable = rules.writable
  const [days, setDays] = useState(maxDays === undefined ? '' : String(maxDays))
  return (
    <>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <TextField
          label="Entries expire after at most"
          type="number"
          min={1}
          max={3650}
          value={days}
          description="days; empty allows entries without an expiry"
          isDisabled={!writable}
          className="w-56"
          onChange={(text) => {
            setDays(text)
            const parsed = Number(text)
            if (!text.trim()) {
              const { maxDays: _drop, ...rest } = policy
              rules.onChange(rest)
            } else if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650)
              rules.onChange({ ...policy, maxDays: parsed })
          }}
        />
        <Switch
          label="Reason required"
          isSelected={requireReason}
          isDisabled={!writable}
          onChange={(next) => rules.onChange({ ...policy, requireReason: next })}
        />
      </div>
      {rows.length ? (
        <Table label="Allowlist entries">
          <thead>
            <tr>
              <Th>Advisory</Th>
              <Th>Reason</Th>
              <Th>Expires</Th>
              {writable ? <Th align="right">Actions</Th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const problem = changed(row)
                ? allowlistRowProblem({ maxDays, requireReason }, row, today)
                : undefined
              const expired = row.expires !== undefined && row.expires < today
              return (
                <Tr key={`${row.id}:${row.package ?? ''}#${index}`}>
                  <Td>
                    <div className="flex flex-col">
                      <span className="mono">{row.id}</span>
                      {row.package ? (
                        <span className="mono text-xs text-muted">{row.package}</span>
                      ) : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col">
                      <span>{row.reason || '—'}</span>
                      {problem ? <span className="text-xs text-danger">{problem}</span> : null}
                    </div>
                  </Td>
                  <Td>
                    {row.expires ? (
                      <Tag tone={expired ? 'danger' : 'default'} mono>
                        {expired ? `Expired ${row.expires}` : row.expires}
                      </Tag>
                    ) : (
                      <span className="text-xs text-muted">Never</span>
                    )}
                  </Td>
                  {writable ? (
                    <Td align="right">
                      <span className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() =>
                            list.onChange(
                              rows.with(index, {
                                ...row,
                                expires: addDays(today, Math.min(maxDays ?? 30, 30)),
                              }),
                            )
                          }
                        >
                          Extend
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          isIconOnly
                          aria-label={`Remove ${row.id}`}
                          onPress={() => list.onChange(rows.filter((_, other) => other !== index))}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </span>
                    </Td>
                  ) : null}
                </Tr>
              )
            })}
          </tbody>
        </Table>
      ) : (
        <p className="text-xs text-muted">No allowlisted advisory at this scope.</p>
      )}
      {writable ? <AllowlistEntryForm onAdd={(row) => list.onChange([...rows, row])} /> : null}
      <p className="text-xs text-muted">
        The limits apply to entries added, changed or renewed from now on, here and in the Inbox.
      </p>
    </>
  )
}

/** A policy edited with the editor its schema calls for, as in the entry dialog. */
function SchemaPolicy({ bound, resetKey }: { bound: Bound; resetKey: string }) {
  const editor = editorFor(bound.definition.schema, false)
  return (
    <div inert={!bound.writable} className={bound.writable ? '' : 'opacity-70'}>
      <ValueEditor
        key={resetKey}
        editor={editor}
        schema={bound.definition.schema}
        initial={bound.value}
        label={bound.definition.label}
        onChange={(value) => value !== undefined && bound.onChange(value)}
      />
    </div>
  )
}

const knowledgeKinds = [
  { id: 'quirk', label: 'Quirks' },
  { id: 'howto', label: 'How-tos' },
  { id: 'migration', label: 'Migrations' },
  { id: 'convention', label: 'Conventions' },
  { id: 'decision', label: 'Decisions' },
] as const

const learningSources = [
  { id: 'mcp', label: 'Proposed over MCP' },
  { id: 'review-reply', label: 'Review replies' },
] as const

const guideSectionOptions = [
  { id: 'general', label: 'General' },
  { id: 'testing', label: 'Testing' },
  { id: 'testids', label: 'Test ids' },
  { id: 'commits', label: 'Commits' },
] as const

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []

const picked = <T extends string>(options: readonly { id: T }[], values: readonly string[]) =>
  options.filter((option) => values.includes(option.id)).map((option) => option.id)

function AutoAcceptRow({
  id,
  title,
  hint,
  children,
}: {
  id?: string
  title: string
  hint: string
  children: ReactNode
}) {
  return (
    <div id={id} className="flex scroll-mt-4 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-1.5 text-xs">
        <span className="font-semibold">{title}</span>
        <span className="text-muted">· {hint}</span>
      </div>
      {children}
    </div>
  )
}

function AgentKnowledgePolicy({
  notes,
  learnings,
  guide,
}: {
  notes: Bound
  learnings: Bound | undefined
  guide: Bound | undefined
}) {
  const learningValue = recordOf(learnings?.value)
  const sources = listOf(learnings?.value, 'sources')
  const scope = learningValue.scope === 'repo' ? 'repo' : 'suggested'
  return (
    <div
      className={`flex flex-col gap-4 ${notes.writable ? '' : 'opacity-70'}`}
      inert={!notes.writable}
    >
      <AutoAcceptRow title="Notes" hint="kinds of knowledge notes agents add without review">
        <MultiToggle
          aria-label="Notes accepted without review"
          options={knowledgeKinds}
          value={picked(knowledgeKinds, stringsOf(notes.value))}
          onChange={notes.onChange}
        />
      </AutoAcceptRow>
      {learnings ? (
        <AutoAcceptRow
          id={settingAnchor(LEARNINGS)}
          title="Learnings"
          hint="rule candidates accepted into the Guide at once"
        >
          <div className="flex flex-wrap items-center gap-3">
            <MultiToggle
              aria-label="Learnings accepted without review"
              options={learningSources}
              value={picked(learningSources, sources)}
              onChange={(next) => learnings.onChange({ sources: next, scope })}
            />
            <Segmented
              aria-label="Accept learnings into"
              options={[
                { id: 'suggested', label: 'Suggested scope' },
                { id: 'repo', label: 'Repository only' },
              ]}
              value={scope}
              isDisabled={!sources.length}
              onChange={(next) => learnings.onChange({ sources, scope: next })}
            />
          </div>
        </AutoAcceptRow>
      ) : null}
      {guide ? (
        <AutoAcceptRow
          id={settingAnchor(GUIDE)}
          title="Generated Guide"
          hint="sections agents use as soon as the guide job writes them"
        >
          <MultiToggle
            aria-label="Generated Guide sections accepted without review"
            options={guideSectionOptions}
            value={picked(guideSectionOptions, stringsOf(guide.value))}
            onChange={guide.onChange}
          />
        </AutoAcceptRow>
      ) : null}
      <span className="text-xs text-muted">
        Auto-accepted items show as accepted by Auto-accept in Knowledge and History; reject them
        there to take them back out.
      </span>
    </div>
  )
}

function RepoTestsPolicy({ bound }: { bound: Bound }) {
  const value = recordOf(bound.value)
  const expected = value.expected !== false
  const reason = typeof value.reason === 'string' ? value.reason : ''
  const write = (next: { expected: boolean; reason: string }) =>
    bound.onChange(
      next.expected || !next.reason.trim()
        ? { expected: next.expected }
        : { expected: false, reason: next.reason },
    )
  return (
    <div className="flex flex-col gap-3">
      <Switch
        label="Repositories have tests"
        description="Off: coverage is skipped and agents neither write nor ask for tests. A repository can turn tests back on in the Resolver."
        isSelected={expected}
        isDisabled={!bound.writable}
        onChange={(next) => write({ expected: next, reason })}
      />
      {expected ? null : (
        <TextField
          label="Reason"
          value={reason}
          onChange={(next) => write({ expected: false, reason: next })}
          placeholder="Configuration only"
          isDisabled={!bound.writable}
          className="max-w-md"
        />
      )}
    </div>
  )
}

function AnalyzersOffPolicy({ bound }: { bound: Bound }) {
  const options = analyzerOptions(bound.definition.schema)
  const read = readAnalyzersOff(bound.value)
  const off = read.off.filter((kind) => options.some((option) => option.id === kind))
  const { reason } = read
  return (
    <div
      className={`flex flex-col gap-3 ${bound.writable ? '' : 'opacity-70'}`}
      inert={!bound.writable}
    >
      <MultiToggle
        aria-label="Analyzers that never run automatically"
        options={options}
        value={off}
        onChange={(next) => bound.onChange(analyzersOffValue(next, reason))}
      />
      {off.length ? (
        <TextField
          label="Reason"
          value={reason}
          onChange={(next) => bound.onChange(analyzersOffValue(off, next))}
          placeholder="Configuration values only"
          className="max-w-md"
        />
      ) : null}
      <span className="text-xs text-muted">
        Off analyzers are never queued automatically and show as Off on repository health and the
        overview; a manual run still goes ahead. A repository can turn them back on in the Resolver.
      </span>
    </div>
  )
}

function MergeRequestCommentsPolicy({ bound }: { bound: Bound }) {
  const value = recordOf(bound.value)
  const enabled = value.enabled !== false
  const reason = typeof value.reason === 'string' ? value.reason : ''
  const write = (next: { enabled: boolean; reason: string }) =>
    bound.onChange(
      next.enabled || !next.reason.trim()
        ? { enabled: next.enabled }
        : { enabled: false, reason: next.reason },
    )
  return (
    <div className="flex flex-col gap-3">
      <Switch
        label="Review and comment on merge requests"
        description="Off: no AI review runs and Holtkeeper posts nothing on merge requests. Unlike Read-only, branches, merge requests Holtkeeper opens and default-branch analyses keep working. A repository can turn it back on in the Resolver."
        isSelected={enabled}
        isDisabled={!bound.writable}
        onChange={(next) => write({ enabled: next, reason })}
      />
      {enabled ? null : (
        <TextField
          label="Reason"
          value={reason}
          onChange={(next) => write({ enabled: false, reason: next })}
          placeholder="Team reviews by hand"
          isDisabled={!bound.writable}
          className="max-w-md"
        />
      )}
    </div>
  )
}

function TryTitle({ repos }: { repos: readonly string[] }) {
  const [repo, setRepo] = useState<string>()
  const [message, setMessage] = useState('')
  const check = useCheckCommitConventions()
  const target = repo ?? repos[0]
  const result: CommitConventionsCheckResult | undefined = check.data
  if (!repos.length) return null
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label="Repository"
          options={repos.map((key) => ({ id: key, label: key }))}
          value={target}
          onChange={(next) => {
            setRepo(next)
            check.reset()
          }}
          className="w-64"
        />
        <TextField
          label="Try a title"
          value={message}
          onChange={(next) => {
            setMessage(next)
            check.reset()
          }}
          mono
          placeholder="feat(cart): [ABC-123] add the summary"
          className="min-w-64 flex-1"
        />
        <Button
          size="sm"
          isDisabled={!target || !message.trim() || check.isPending}
          onPress={() => target && check.mutate({ repo: target, message })}
        >
          Check
        </Button>
      </div>
      {check.isError ? <span className="text-xs text-danger">{messageOf(check.error)}</span> : null}
      {result ? (
        result.problems.length ? (
          <ul className="flex flex-col gap-0.5 text-xs">
            {result.problems.map((problem) => (
              <li key={`${problem.target}:${problem.rule}:${problem.message}`}>
                <Tag tone={problem.severity === 'error' ? 'danger' : 'warning'}>
                  {problem.severity === 'error' ? 'Fails' : 'Unusual'}
                </Tag>{' '}
                {problem.message}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-success">Passes every known rule.</span>
        )
      ) : (
        <span className="text-xs text-muted">Checks against the saved conventions.</span>
      )}
    </div>
  )
}

const cards = [
  { key: LICENSES, title: 'License policy', page: { label: 'Licenses', to: '/supply/licenses' } },
  {
    key: ALLOWLIST_RULES,
    title: 'Security allowlist',
    page: { label: 'Security', to: '/supply/security' },
  },
  {
    key: 'audit.fix',
    title: 'Vulnerability fixes',
    page: { label: 'Security', to: '/supply/security' },
  },
  {
    key: 'analyzers.stack',
    title: 'Stack conventions',
    page: { label: 'Stack', to: '/supply/stack' },
  },
  { key: 'assets.policy', title: 'Asset policy', page: { label: 'Assets', to: '/quality/assets' } },
  { key: 'commits.conventions', title: 'Commit conventions' },
  { key: TESTS, title: 'Tests', page: { label: 'Coverage', to: '/quality/coverage' } },
  { key: ANALYZERS_OFF, title: 'Analyzers off' },
  { key: MR_COMMENTS, title: 'Merge request reviews' },
  {
    key: 'analyzers.testids',
    title: 'Test ids',
    page: { label: 'Reviews', to: '/quality/reviews' },
  },
  {
    key: KNOWLEDGE,
    title: 'Agent knowledge',
    page: { label: 'Knowledge', to: '/knowledge/notes' },
  },
] as const

const CARD_KEYS: Readonly<Record<string, readonly string[]>> = {
  [ALLOWLIST_RULES]: [ALLOWLIST_RULES, ALLOWLIST],
  [KNOWLEDGE]: [KNOWLEDGE, LEARNINGS, GUIDE],
  'audit.fix': ['audit.fix', 'audit.upgrade'],
}

function PoliciesBody({ data }: { data: SettingList }) {
  const titleOf = useGroupTitles()
  const { can, canGlobal, principal } = useSession()
  const repos = useRepos(can('repos:read'))
  const save = useSavePolicyDraft()
  const [focus, setFocus] = useState<PolicyFocus>({ kind: 'org' })
  const [draft, setDraft] = useState<PolicyDraft>({})
  const [generation, setGeneration] = useState(0)
  const writable =
    focus.kind === 'org'
      ? canGlobal('settings:write')
      : canInGroup(principal, 'settings:write', focus.group)
  const entries: readonly SettingView[] = data.settings
  const today = isoDay(new Date())
  const groups = useGroupNames(can('repos:read'))
  const focusId = focus.kind === 'org' ? 'org' : `group:${focus.group}`
  const focusLabel = focus.kind === 'org' ? 'Organization' : `Group ${titleOf(focus.group)}`
  const count = draftCount(draft)

  const bind = (definition: SettingDefinitionView): Bound => {
    const shown = draftValue(entries, draft, definition.key, focus, definition.default)
    return {
      definition,
      ...shown,
      writable,
      onChange: (value) =>
        setDraft((current) => withEdit(entries, current, definition.key, focus, value)),
      onReset: () => {
        setDraft((current) => withReset(entries, current, definition.key, focus))
        setGeneration((n) => n + 1)
      },
    }
  }
  const definitionOf = (key: string) => definitionsOf(data.definitions, [key])[0]

  const discard = () => {
    setDraft({})
    setGeneration((n) => n + 1)
  }
  const submit = () =>
    save.mutate(
      { changes: draftChanges(entries, draft, focus) },
      {
        onSuccess: (result) => {
          notify.success(
            'Policies saved',
            `${result.saved.length + result.removed.length} ${result.saved.length + result.removed.length === 1 ? 'change' : 'changes'} for ${focusLabel}`,
          )
          setDraft({})
          setGeneration((n) => n + 1)
        },
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )

  const storedAllowlist = allowlistRows(focusEntry(entries, ALLOWLIST, focus)?.value)
  const focusRepos = (repos.data?.repos ?? [])
    .filter((repo) => focus.kind === 'org' || repo.groups.includes(focus.group))
    .map((repo) => `${repo.repo.forge}:${repo.repo.path}`)

  return (
    <div className="flex flex-col gap-5">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-background/95 py-2 backdrop-blur">
        <span className="text-xs text-muted">Editing for</span>
        {groups.length ? (
          <Segmented
            aria-label="Editing for"
            options={[
              { id: 'org', label: 'Organization defaults' },
              ...groups.map((group) => ({
                id: `group:${group}`,
                label: `Group ${titleOf(group)}`,
              })),
            ]}
            value={focusId}
            onChange={(id) => {
              if (count) {
                notify.error('Save or discard first', 'Unsaved changes belong to one scope.')
                return
              }
              setFocus(id === 'org' ? { kind: 'org' } : { kind: 'group', group: id.slice(6) })
              setGeneration((n) => n + 1)
            }}
          />
        ) : (
          <Tag>Organization defaults</Tag>
        )}
        {writable ? (
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" isDisabled={!count} onPress={discard}>
              Discard
            </Button>
            <Button
              size="sm"
              variant="primary"
              isDisabled={!count || save.isPending}
              onPress={submit}
            >
              {count ? `Save ${count} ${count === 1 ? 'change' : 'changes'}` : 'Save'}
            </Button>
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted">
        Groups override the organization; a repository can override its groups in the Resolver.
        Merge request policies and freshness live in{' '}
        <Link to="/ops/automation" className="underline">
          Ops › Automation
        </Link>
        .
      </p>
      {cards.map((card) => {
        const definition = definitionOf(card.key)
        if (!definition) return null
        const bound = bind(definition)
        const resetKey = `${focusId}:${generation}`
        const common = {
          id: settingAnchor(card.key),
          title: card.title,
          bound,
          focusLabel,
          unknownKeys: focusUnknownKeys(entries, draft, CARD_KEYS[card.key] ?? [card.key], focus),
          ...('page' in card ? { page: card.page } : {}),
        }
        if (card.key === LICENSES)
          return (
            <PolicyCard key={card.key} {...common}>
              <LicensePolicy key={resetKey} bound={bound} author={principal.name} />
            </PolicyCard>
          )
        if (card.key === ALLOWLIST_RULES) {
          const listDefinition = definitionOf(ALLOWLIST)
          if (!listDefinition) return null
          const list = bind(listDefinition)
          const both = {
            ...bound,
            edited: bound.edited || list.edited,
            inherited: bound.inherited && list.inherited,
            onReset: () => {
              setDraft((current) =>
                withReset(
                  entries,
                  withReset(entries, current, ALLOWLIST_RULES, focus),
                  ALLOWLIST,
                  focus,
                ),
              )
              setGeneration((n) => n + 1)
            },
          }
          return (
            <PolicyCard key={card.key} {...common} bound={both}>
              <SecurityAllowlist
                key={resetKey}
                rules={bound}
                list={list}
                stored={storedAllowlist}
                today={today}
              />
            </PolicyCard>
          )
        }
        if (card.key === KNOWLEDGE) {
          const others = [definitionOf(LEARNINGS), definitionOf(GUIDE)].map((each) =>
            each ? bind(each) : undefined,
          )
          const [learnings, guide] = others
          const all = [bound, ...others.filter((each) => each !== undefined)]
          const combined = {
            ...bound,
            edited: all.some((each) => each.edited),
            inherited: all.every((each) => each.inherited),
            onReset: () => {
              setDraft((current) =>
                [KNOWLEDGE, LEARNINGS, GUIDE].reduce(
                  (next, key) => withReset(entries, next, key, focus),
                  current,
                ),
              )
              setGeneration((n) => n + 1)
            },
          }
          return (
            <PolicyCard key={card.key} {...common} bound={combined}>
              <AgentKnowledgePolicy notes={bound} learnings={learnings} guide={guide} />
            </PolicyCard>
          )
        }
        if (card.key === TESTS)
          return (
            <PolicyCard key={card.key} {...common}>
              <RepoTestsPolicy key={resetKey} bound={bound} />
            </PolicyCard>
          )
        if (card.key === ANALYZERS_OFF)
          return (
            <PolicyCard key={card.key} {...common}>
              <AnalyzersOffPolicy key={resetKey} bound={bound} />
            </PolicyCard>
          )
        if (card.key === MR_COMMENTS)
          return (
            <PolicyCard key={card.key} {...common}>
              <MergeRequestCommentsPolicy key={resetKey} bound={bound} />
            </PolicyCard>
          )
        if (card.key === 'audit.fix') {
          const upgrade = definitionOf('audit.upgrade')
          const upgradeBound = upgrade ? bind(upgrade) : undefined
          return (
            <PolicyCard key={card.key} {...common}>
              <div className="flex flex-wrap items-end gap-6">
                <Switch
                  label="Open merge requests that fix vulnerabilities"
                  isSelected={bound.value === true}
                  isDisabled={!writable}
                  onChange={bound.onChange}
                />
                {upgradeBound ? (
                  <Select
                    label="Largest upgrade"
                    options={[
                      { id: 'patch', label: 'Patch' },
                      { id: 'minor', label: 'Minor' },
                      { id: 'major', label: 'Major' },
                    ]}
                    value={typeof upgradeBound.value === 'string' ? upgradeBound.value : 'major'}
                    isDisabled={!writable}
                    onChange={upgradeBound.onChange}
                    className="w-40"
                  />
                ) : null}
              </div>
            </PolicyCard>
          )
        }
        return (
          <PolicyCard key={card.key} {...common}>
            <SchemaPolicy bound={bound} resetKey={resetKey} />
            {card.key === 'commits.conventions' ? <TryTitle repos={focusRepos} /> : null}
          </PolicyCard>
        )
      })}
      {!writable ? (
        <Notice title="Read only">
          Changing these policies for {focusLabel} needs settings:write on that scope.
        </Notice>
      ) : null}
    </div>
  )
}

/**
 * Settings › Policies: the rules analyzers check against (license policy, security allowlist and
 * its rules, vulnerability fixes, stack conventions, asset policy, commit conventions, whether
 * repositories have tests (`repo.tests`), analyzers turned off (`repo.analyzers`), merge request
 * reviews (`mergeRequests.comments`), test ids) and
 * which agent knowledge needs no review
 * (`knowledge.autoAccept`, `learnings.autoAccept`, `guide.autoAccept`, one card),
 * for the organization or one group. Edits gather into one draft over several keys, saved at once
 * through `POST /api/settings/draft`; their pages keep editing the same entries.
 */
export function PoliciesSection() {
  const { can } = useSession()
  const settings = useSettings(can('settings:read'))
  if (!can('settings:read')) return null
  if (settings.isError) return <ErrorState error={settings.error} />
  if (!settings.data) return <Placeholder className="h-96" />
  if (
    !definitionsOf(
      settings.data.definitions,
      cards.map((card) => card.key),
    ).length
  )
    return <EmptyState title="No policies" description="This server defines no policy settings." />
  return <PoliciesBody data={settings.data} />
}
