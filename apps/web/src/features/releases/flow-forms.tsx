import type { ReleaseSettings, SettingView } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  GitBranch,
  GitPullRequestArrow,
  Plus,
  Server,
  Tag as TagIcon,
  Trash2,
  Waypoints,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { useDescribeScope } from '../../api/queries.ts'
import { formatRelative } from '../../lib/format.ts'
import {
  type FieldSource,
  type FlowStripItem,
  type SignalRow,
  type flowStrip,
  acceptanceLabels,
  acceptances,
  addEnvironment,
  combinedSource,
  exampleTag,
  modeLabels,
  modes,
  withEnvironment,
} from '../../lib/release-flow.ts'
import {
  Button,
  KeyValue,
  Segmented,
  Select,
  Switch,
  Table,
  Tag,
  TagInput,
  Td,
  TextField,
  Th,
} from '../../ui/index.ts'

type Mode = ReleaseSettings['flow']['mode']

/** What every form of the release setup takes: the draft, its errors and each field's source. */
interface FlowFormProps {
  draft: ReleaseSettings
  onChange: (next: ReleaseSettings) => void
  sourceOf: (path: string) => FieldSource
  errors: Record<string, string>
}

const sourceTone = {
  detected: 'info',
  edited: 'accent',
  saved: 'default',
  default: 'default',
} as const

/** Where a value comes from: detected, edited, saved or the Holtkeeper default. */
function SourceTag({ source }: { source: FieldSource }) {
  return <Tag tone={sourceTone[source]}>{source}</Tag>
}

function Labeled({ children, source }: { children: ReactNode; source: FieldSource }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      <SourceTag source={source} />
    </span>
  )
}

const modeHints: Record<Mode, string> = {
  'merge-request':
    'Changes move from a source branch into the target through one merge request; versions are tagged on the target.',
  trunk: 'Versions are tagged straight on one branch after a person accepts them.',
  external:
    'changesets, release-please or another tool tags. Holtkeeper shows versions and can still deploy them.',
}

function ModeChoice({
  value,
  onChange,
  source,
}: {
  value: Mode
  onChange: (mode: Mode) => void
  source: FieldSource
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-xs text-muted">
        <Labeled source={source}>How does this repository release?</Labeled>
      </legend>
      <div className="grid gap-2 md:grid-cols-3">
        {modes.map((mode) => (
          <label
            key={mode}
            aria-label={modeLabels[mode]}
            className={`flex cursor-pointer gap-2.5 rounded-[7px] border p-3 text-[12.5px] ${
              value === mode ? 'border-accent bg-raise' : 'border-line hover:bg-raise'
            }`}
          >
            <input
              type="radio"
              name="release-mode"
              className="mt-0.5 accent-[var(--brand)]"
              checked={value === mode}
              onChange={() => onChange(mode)}
            />
            <span className="flex flex-col gap-1">
              <b className="font-medium">{modeLabels[mode]}</b>
              <span className="text-muted">{modeHints[mode]}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

const acceptanceOptions = acceptances.map((id) => ({ id, label: acceptanceLabels[id] }))

/** Step 1: flow mode, branches, the release MR, acceptance and gates. */
export function FlowFields({
  draft,
  onChange,
  sourceOf,
  errors,
  defaultBranch,
  labelSuggestions = [],
}: FlowFormProps & { defaultBranch?: string | undefined; labelSuggestions?: readonly string[] }) {
  const { flow, gates } = draft
  const setFlow = (next: Partial<ReleaseSettings['flow']>) =>
    onChange({ ...draft, flow: { ...flow, ...next } })
  const setGates = (next: Partial<ReleaseSettings['gates']>) =>
    onChange({ ...draft, gates: { ...gates, ...next } })
  return (
    <div className="flex flex-col gap-4">
      <ModeChoice
        value={flow.mode}
        onChange={(mode) => setFlow({ mode })}
        source={sourceOf('flow.mode')}
      />
      {flow.mode === 'external' ? null : (
        <div className="grid gap-4 md:grid-cols-2">
          {flow.mode === 'merge-request' ? (
            <TextField
              label={<Labeled source={sourceOf('flow.source')}>Source branch</Labeled>}
              description="Changes come from here into the target through a release merge request."
              value={flow.source}
              onChange={(source) => setFlow({ source })}
              error={errors['flow.source']}
              mono
            />
          ) : null}
          <TextField
            label={<Labeled source={sourceOf('flow.target')}>Target branch</Labeled>}
            description="Versions are tagged here."
            placeholder={defaultBranch ?? 'default branch'}
            value={flow.target ?? ''}
            onChange={(target) => setFlow({ target })}
            error={errors['flow.target']}
            mono
          />
          {flow.mode === 'merge-request' ? (
            <TagInput
              label={<Labeled source={sourceOf('mergeRequest.labels')}>Release MR labels</Labeled>}
              values={draft.mergeRequest.labels}
              suggestions={labelSuggestions}
              onChange={(labels) =>
                onChange({ ...draft, mergeRequest: { ...draft.mergeRequest, labels } })
              }
            />
          ) : null}
          <Select
            label={<Labeled source={sourceOf('acceptance')}>Accepted by</Labeled>}
            options={acceptanceOptions}
            value={draft.acceptance}
            onChange={(id) => {
              const next = acceptanceOptions.find((option) => option.id === id)
              if (next) onChange({ ...draft, acceptance: next.id })
            }}
          />
        </div>
      )}
      {flow.mode === 'external' ? null : (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <h3 className="text-[13px] font-semibold">Gates</h3>
          <Switch
            label={
              <Labeled source={sourceOf('gates.pipeline')}>
                A failed pipeline of the target blocks the step
              </Labeled>
            }
            isSelected={gates.pipeline}
            onChange={(pipeline) => setGates({ pipeline })}
          />
          <TagInput
            label={<Labeled source={sourceOf('gates.blockingLabels')}>Blocking labels</Labeled>}
            description="Open merge requests with one of these labels block releasing."
            placeholder="do-not-release"
            values={gates.blockingLabels}
            onChange={(blockingLabels) => setGates({ blockingLabels })}
          />
        </div>
      )}
    </div>
  )
}

/** Step 2: version scheme, tag format, release candidates and the changelog. */
export function VersionFields({ draft, onChange, sourceOf, errors }: FlowFormProps) {
  const { version, changelog } = draft
  const setVersion = (next: Partial<ReleaseSettings['version']>) =>
    onChange({ ...draft, version: { ...version, ...next } })
  const setChangelog = (next: Partial<ReleaseSettings['changelog']>) =>
    onChange({ ...draft, changelog: { ...changelog, ...next } })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">
          <Labeled source={sourceOf('version.scheme')}>Scheme</Labeled>
        </span>
        <Segmented
          aria-label="Scheme"
          options={[
            { id: 'semver', label: 'Semantic' },
            { id: 'calver', label: 'Calendar YYYY.MM.N' },
          ]}
          value={version.scheme}
          onChange={(scheme) => setVersion({ scheme })}
        />
        <span className="text-xs text-dim">
          The bump follows the commit conventions: breaking → major, feat → minor, else patch.
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          label={<Labeled source={sourceOf('version.tagFormat')}>Tag format</Labeled>}
          description={
            <>
              Next tags look like <span className="mono">{exampleTag(version)}</span>
            </>
          }
          value={version.tagFormat}
          onChange={(tagFormat) => setVersion({ tagFormat })}
          error={errors['version.tagFormat']}
          mono
        />
        <TextField
          label={<Labeled source={sourceOf('changelog.ticketUrl')}>Tracker URL</Labeled>}
          description="With {id}, e.g. https://tracker.example.com/browse/{id}"
          value={changelog.ticketUrl ?? ''}
          onChange={(ticketUrl) => setChangelog({ ticketUrl })}
          mono
        />
      </div>
      <Switch
        label={
          <Labeled source={sourceOf('version.prerelease')}>
            Release candidates first (1.2.0-rc.1, rc.2, …)
          </Labeled>
        }
        isSelected={version.prerelease}
        onChange={(prerelease) => setVersion({ prerelease })}
      />
      <Switch
        label={
          <Labeled source={sourceOf('changelogFile')}>Prepend the notes to CHANGELOG.md</Labeled>
        }
        isSelected={draft.changelogFile}
        onChange={(changelogFile) => onChange({ ...draft, changelogFile })}
      />
      <TagInput
        label={
          <Labeled source={sourceOf('changelog.excludeTypes')}>
            Commit types left out of the changelog
          </Labeled>
        }
        placeholder="ci"
        values={changelog.excludeTypes}
        onChange={(excludeTypes) => setChangelog({ excludeTypes })}
      />
      <p className="text-xs text-dim">
        The release notes style is a Guide rule (section Releases), not a field here.{' '}
        <Link to="/knowledge/guide" className="underline">
          Open the Guide
        </Link>
      </p>
    </div>
  )
}

const none = '__none'

/** Step 3: environments in deploy order, each with its job, predecessor and confirmation. */
export function EnvironmentFields({ draft, onChange, sourceOf, errors }: FlowFormProps) {
  const environments = draft.deploy.environments
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">
          <Labeled source={sourceOf('deploy.environments')}>
            {environments.length
              ? `${environments.length} environment${environments.length === 1 ? '' : 's'}`
              : 'No environments: versions are tagged, never deployed from here'}
          </Labeled>
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="ms-auto"
          onPress={() => onChange(addEnvironment(draft))}
        >
          <Plus className="size-3.5" />
          Environment
        </Button>
      </div>
      {environments.map((environment, index) => {
        const others = environments.filter((_, at) => at !== index)
        const update = (next: typeof environment | undefined) =>
          onChange(withEnvironment(draft, index, next))
        return (
          <div
            key={index}
            className="grid items-start gap-3 rounded-[12px] border border-line p-3 md:grid-cols-[1fr_1fr_1fr_auto]"
          >
            <TextField
              label="Name"
              value={environment.name}
              onChange={(name) => update({ ...environment, name })}
              error={errors[`deploy.environments.${index}.name`]}
              mono
            />
            <TextField
              label="Deploy job"
              description="Manual job of the tag pipeline (glob); the name when empty."
              value={environment.job ?? ''}
              onChange={(job) => update({ ...environment, job })}
              mono
            />
            <Select
              label="After"
              options={[
                { id: none, label: 'Right after the tag' },
                ...others
                  .filter((env) => env.name.trim())
                  .map((env) => ({ id: env.name, label: env.name })),
              ]}
              value={environment.after ?? none}
              onChange={(after) => {
                const { after: _old, ...rest } = environment
                update(after === none ? rest : { ...rest, after })
              }}
            />
            <div className="flex flex-col items-end gap-2 pt-5">
              <Switch
                label="Ask first"
                isSelected={environment.confirm}
                onChange={(confirm) => update({ ...environment, confirm })}
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${environment.name || 'environment'}`}
                onPress={() => update(undefined)}
              >
                <Trash2 className="size-3.5" />
                Remove
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

const stripIcon = (item: FlowStripItem) => {
  if (item.id === 'request') return <GitPullRequestArrow className="size-3.5" />
  if (item.id === 'external') return <Waypoints className="size-3.5" />
  if (item.id === 'tag') return <TagIcon className="size-3.5" />
  if (item.step === 'deploy') return <Server className="size-3.5" />
  return <GitBranch className="size-3.5" />
}

/**
 * The draft flow left to right (branches, tags, environments), each step with its source; a
 * click on a step calls `onSelect` with it, to open the setup step that edits it.
 */
export function FlowStripView({
  groups,
  sourceOf,
  onSelect,
}: {
  groups: ReturnType<typeof flowStrip>
  sourceOf: (path: string) => FieldSource
  onSelect?: (item: FlowStripItem) => void
}) {
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {groups.map((group, at) => (
        <div key={group.label} className="flex items-stretch gap-2">
          {at > 0 ? <ArrowRight aria-hidden className="size-3.5 self-center text-dim" /> : null}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-dim">{group.label}</span>
            <div className="flex flex-wrap items-stretch gap-1.5">
              {group.items.length === 0 ? (
                <span className="self-center text-xs text-muted">none yet</span>
              ) : null}
              {group.items.map((item) => {
                const body = (
                  <>
                    <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                      <span className="text-muted">{stripIcon(item)}</span>
                      <span className={item.mono ? 'mono' : ''}>{item.title}</span>
                    </span>
                    <span className="text-[11px] text-muted">{item.detail}</span>
                    <SourceTag source={combinedSource(item.paths.map(sourceOf))} />
                  </>
                )
                const className =
                  'flex min-w-0 flex-col gap-1 rounded-[7px] border border-line bg-raise px-2.5 py-2 text-left'
                return onSelect ? (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(item)}
                    className={`${className} hover:border-line-strong`}
                  >
                    {body}
                  </button>
                ) : (
                  <div key={item.id} className={className}>
                    {body}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

const list = (values: readonly string[]) => (values.length ? values.join(', ') : '—')

/** The settings as labelled lines, for people who may read but not change them. */
export function FlowSummary({
  settings,
  defaultBranch,
}: {
  settings: ReleaseSettings
  defaultBranch?: string | undefined
}) {
  const { flow, version, gates, changelog } = settings
  return (
    <KeyValue
      labelWidth={160}
      rows={[
        { label: 'Releases', value: settings.enabled ? 'On' : 'Off' },
        { label: 'Flow', value: modeLabels[flow.mode] },
        ...(flow.mode === 'merge-request'
          ? [{ label: 'Source branch', value: <span className="mono">{flow.source}</span> }]
          : []),
        ...(flow.mode === 'external'
          ? []
          : [
              {
                label: 'Target branch',
                value: (
                  <span className="mono">{flow.target ?? defaultBranch ?? 'default branch'}</span>
                ),
              },
              { label: 'Accepted by', value: acceptanceLabels[settings.acceptance] },
              {
                label: 'Pipeline gate',
                value: gates.pipeline ? 'A failed pipeline blocks' : 'Off',
              },
              { label: 'Blocking labels', value: list(gates.blockingLabels) },
            ]),
        ...(flow.mode === 'merge-request'
          ? [{ label: 'Release MR labels', value: list(settings.mergeRequest.labels) }]
          : []),
        {
          label: 'Tags',
          value: (
            <span className="mono">
              {version.tagFormat} · {exampleTag(version)}
            </span>
          ),
        },
        { label: 'CHANGELOG.md', value: settings.changelogFile ? 'Prepend the notes' : 'Off' },
        { label: 'Left out types', value: list(changelog.excludeTypes) },
        {
          label: 'Environments',
          value: list(
            settings.deploy.environments.map(
              (env) => `${env.name}${env.after ? ` (after ${env.after})` : ''}`,
            ),
          ),
        },
      ]}
    />
  )
}

const kindLabels: Record<SignalRow['kind'], string> = {
  'merge-request': 'Merge request',
  label: 'Label',
  tag: 'Tag',
  file: 'File',
  commits: 'Commits',
  'pipeline-job': 'Pipeline job',
  branch: 'Branch',
}

/** "What we read": each piece of evidence detection used and the settings it suggests. */
export function SignalTable({ rows }: { rows: readonly SignalRow[] }) {
  return (
    <Table label="What detection read">
      <thead>
        <tr>
          <Th>Signal</Th>
          <Th>What</Th>
          <Th>Where</Th>
          <Th>When</Th>
          <Th>Suggests</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            <Td>
              <Tag>{kindLabels[row.kind]}</Tag>
            </Td>
            <Td>
              <span className="mono">{row.what}</span>{' '}
              {row.note ? <span className="text-muted">{row.note}</span> : null}
            </Td>
            <Td>
              <span className="mono text-xs">{row.where || '—'}</span>
            </Td>
            <Td>
              <span className="text-xs text-muted">{row.at ? formatRelative(row.at) : '—'}</span>
            </Td>
            <Td>
              {row.suggests.length ? row.suggests.join('; ') : <span className="text-dim">—</span>}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

/**
 * Release webhooks (`releases.notify`), read-only: they are instance-wide sealed settings, so
 * only their scope and last change show; they are managed in Settings › Integrations.
 */
export function NotifyWebhooks({ entries }: { entries: readonly SettingView[] }) {
  const describeScope = useDescribeScope()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold">Notify webhooks</h3>
        <span className="text-xs text-muted">
          Shared release webhooks, sealed because their URLs are credentials · read-only here
        </span>
        <Link
          to="/settings/$section"
          params={{ section: 'integrations' }}
          className="ms-auto text-xs underline"
        >
          Manage in Settings
        </Link>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-muted">No release webhooks are set up.</p>
      ) : (
        <Table label="Release webhooks">
          <thead>
            <tr>
              <Th>Applies to</Th>
              <Th>Targets</Th>
              <Th>Updated</Th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <Td>{describeScope(entry.scope)}</Td>
                <Td>
                  <Tag>sealed</Tag>
                </Td>
                <Td>
                  <span className="text-xs text-muted">{formatRelative(entry.updatedAt)}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}
