import type { ReleaseRepoView, ReleaseSettings, RepoRef } from '@holtkeeper/api'
import { useQueryClient } from '@tanstack/react-query'
import {
  GitBranch,
  GitPullRequestArrow,
  Plus,
  Server,
  Tag as TagIcon,
  Waypoints,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { keys, useResolvedSettings, useSettingMutations } from '../../api/queries.ts'
import {
  type ReleaseFlowNode,
  addEnvironment,
  releaseFlowGraph,
  repoReleaseEntry,
  withEnvironment,
} from '../../lib/release-flow.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  FlowCanvas,
  type FlowDrawer,
  Notice,
  Segmented,
  Select,
  Switch,
  Tag,
  TagInput,
  TextField,
  notify,
} from '../../ui/index.ts'

type Environment = ReleaseSettings['deploy']['environments'][number]

const modes = [
  { id: 'merge-request', label: 'Release MR' },
  { id: 'trunk', label: 'Trunk' },
  { id: 'external', label: 'External' },
] as const

const acceptances = [
  { id: 'none', label: 'Nothing (a person may still accept)' },
  { id: 'manual', label: 'A person, in the panel or API' },
  { id: 'label', label: 'The release-accepted label on the merged MR' },
  { id: 'merge', label: 'Merging the release MR' },
] as const

function useSaveSettings(repo: RepoRef) {
  const resolved = useResolvedSettings(repo)
  const { put } = useSettingMutations()
  const client = useQueryClient()
  const save = (value: ReleaseSettings, message: string) => {
    const entry = repoReleaseEntry(resolved.data?.cascade.releases, repo)
    put.mutate(
      {
        ...(entry ? { id: entry.id } : {}),
        key: 'releases',
        scope: entry?.scope ?? { repos: [repoKey(repo)] },
        value,
      },
      {
        onSuccess: () => {
          notify.success(message)
          void client.invalidateQueries({ queryKey: keys.releases })
        },
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )
  }
  return { save, isPending: put.isPending || resolved.isPending }
}

function Form({
  children,
  onSave,
  isPending,
  extra,
}: {
  children: ReactNode
  onSave: () => void
  isPending: boolean
  extra?: ReactNode
}) {
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      {children}
      <div className="flex items-center gap-2 border-t border-line pt-3">
        {extra}
        <Button type="submit" variant="primary" className="ml-auto" isPending={isPending}>
          Save
        </Button>
      </div>
    </form>
  )
}

function ModeField({
  value,
  onChange,
}: {
  value: ReleaseSettings['flow']['mode']
  onChange: (mode: ReleaseSettings['flow']['mode']) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">Flow</span>
      <Segmented aria-label="Flow" options={modes} value={value} onChange={onChange} />
    </div>
  )
}

type Save = (value: ReleaseSettings, message: string) => void

function SourceForm({
  settings,
  save,
  pending,
}: {
  settings: ReleaseSettings
  save: Save
  pending: boolean
}) {
  const [flow, setFlow] = useState(settings.flow)
  return (
    <Form isPending={pending} onSave={() => save({ ...settings, flow }, 'Flow saved')}>
      <ModeField value={flow.mode} onChange={(mode) => setFlow({ ...flow, mode })} />
      <TextField
        label="Source branch"
        description="Changes come from here into the target through a release merge request."
        value={flow.source}
        onChange={(source) => setFlow({ ...flow, source })}
        mono
      />
    </Form>
  )
}

function TargetForm({
  settings,
  save,
  pending,
}: {
  settings: ReleaseSettings
  save: Save
  pending: boolean
}) {
  const [flow, setFlow] = useState(settings.flow)
  const [gates, setGates] = useState(settings.gates)
  const [acceptance, setAcceptance] = useState(settings.acceptance)
  return (
    <Form
      isPending={pending}
      onSave={() => {
        const { target: _target, ...rest } = flow
        save(
          { ...settings, flow: flow.target?.trim() ? flow : rest, gates, acceptance },
          'Target saved',
        )
      }}
    >
      {flow.mode === 'trunk' ? (
        <ModeField value={flow.mode} onChange={(mode) => setFlow({ ...flow, mode })} />
      ) : null}
      <TextField
        label="Target branch"
        description="Versions are tagged here; the default branch when empty."
        value={flow.target ?? ''}
        onChange={(target) => setFlow({ ...flow, target })}
        mono
      />
      {flow.mode === 'trunk' ? (
        <Select
          label="Accepted by"
          options={acceptances}
          value={acceptance}
          onChange={(id) => {
            const next = acceptances.find((option) => option.id === id)
            if (next) setAcceptance(next.id)
          }}
        />
      ) : null}
      <Switch
        label="A failed pipeline blocks the step"
        isSelected={gates.pipeline}
        onChange={(pipeline) => setGates({ ...gates, pipeline })}
      />
      <TagInput
        label="Blocking labels"
        description="Open merge requests with one of these labels block releasing."
        values={gates.blockingLabels}
        onChange={(blockingLabels) => setGates({ ...gates, blockingLabels })}
      />
    </Form>
  )
}

function RequestForm({
  settings,
  save,
  pending,
}: {
  settings: ReleaseSettings
  save: Save
  pending: boolean
}) {
  const [labels, setLabels] = useState(settings.mergeRequest.labels)
  const [acceptance, setAcceptance] = useState(settings.acceptance)
  return (
    <Form
      isPending={pending}
      onSave={() =>
        save(
          { ...settings, mergeRequest: { ...settings.mergeRequest, labels }, acceptance },
          'Release MR saved',
        )
      }
    >
      <TagInput label="Labels of the release MR" values={labels} onChange={setLabels} />
      <Select
        label="Accepted by"
        options={acceptances}
        value={acceptance}
        onChange={(id) => {
          const next = acceptances.find((option) => option.id === id)
          if (next) setAcceptance(next.id)
        }}
      />
    </Form>
  )
}

function TagForm({
  settings,
  save,
  pending,
}: {
  settings: ReleaseSettings
  save: Save
  pending: boolean
}) {
  const [version, setVersion] = useState(settings.version)
  const [changelogFile, setChangelogFile] = useState(settings.changelogFile)
  const [changelog, setChangelog] = useState(settings.changelog)
  const formatError = version.tagFormat.includes('{version}') ? undefined : 'Must contain {version}'
  return (
    <Form
      isPending={pending}
      onSave={() => {
        if (formatError) return
        const { ticketUrl, ...rest } = changelog
        save(
          { ...settings, version, changelogFile, changelog: ticketUrl?.trim() ? changelog : rest },
          'Versions saved',
        )
      }}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">Scheme</span>
        <Segmented
          aria-label="Scheme"
          options={[
            { id: 'semver', label: 'Semantic' },
            { id: 'calver', label: 'Calendar YYYY.MM.N' },
          ]}
          value={version.scheme}
          onChange={(scheme) => setVersion({ ...version, scheme })}
        />
        <span className="text-xs text-dim">
          The bump follows the commit conventions: breaking → major, feat → minor, else patch.
        </span>
      </div>
      <TextField
        label="Tag format"
        value={version.tagFormat}
        onChange={(tagFormat) => setVersion({ ...version, tagFormat })}
        error={formatError}
        mono
      />
      <Switch
        label="Release candidates first (1.2.0-rc.1, rc.2, …)"
        isSelected={version.prerelease}
        onChange={(prerelease) => setVersion({ ...version, prerelease })}
      />
      <Switch
        label="Prepend the notes to CHANGELOG.md"
        isSelected={changelogFile}
        onChange={setChangelogFile}
      />
      <TagInput
        label="Commit types left out of the changelog"
        placeholder="ci"
        values={changelog.excludeTypes}
        onChange={(excludeTypes) => setChangelog({ ...changelog, excludeTypes })}
      />
      <TextField
        label="Tracker URL"
        description="With {id}, e.g. https://tracker.example.com/browse/{id}"
        value={changelog.ticketUrl ?? ''}
        onChange={(ticketUrl) => setChangelog({ ...changelog, ticketUrl })}
        mono
      />
    </Form>
  )
}

function ExternalForm({
  settings,
  save,
  pending,
}: {
  settings: ReleaseSettings
  save: Save
  pending: boolean
}) {
  const [mode, setMode] = useState(settings.flow.mode)
  return (
    <Form
      isPending={pending}
      onSave={() => save({ ...settings, flow: { ...settings.flow, mode } }, 'Flow saved')}
    >
      <ModeField value={mode} onChange={setMode} />
      <p className="text-sm text-muted">
        Another tool (changesets, release-please, …) tags versions. Holtkeeper shows them and can
        still deploy them.
      </p>
    </Form>
  )
}

function EnvironmentForm({
  settings,
  index,
  save,
  pending,
}: {
  settings: ReleaseSettings
  index: number
  save: Save
  pending: boolean
}) {
  const current = settings.deploy.environments[index]
  const [environment, setEnvironment] = useState<Environment | undefined>(current)
  if (!environment || !current) return null
  const others = settings.deploy.environments.filter((_, at) => at !== index)
  const name = environment.name.trim()
  const nameError = !name
    ? 'Required'
    : others.some((env) => env.name === name)
      ? 'Another environment has this name'
      : undefined
  const none = '__none'
  return (
    <Form
      isPending={pending}
      onSave={() => {
        if (nameError) return
        const { job, after, ...rest } = environment
        save(
          withEnvironment(settings, index, {
            ...rest,
            name,
            ...(job?.trim() ? { job: job.trim() } : {}),
            ...(after ? { after } : {}),
          }),
          `${name} saved`,
        )
      }}
      extra={
        <Button
          variant="danger-soft"
          isPending={pending}
          onPress={() =>
            save(withEnvironment(settings, index, undefined), `${current.name} removed`)
          }
        >
          Remove
        </Button>
      }
    >
      <TextField
        label="Name"
        value={environment.name}
        onChange={(value) => setEnvironment({ ...environment, name: value })}
        error={nameError}
        mono
      />
      <TextField
        label="Deploy job"
        description="Manual job of the tag pipeline (glob); the name when empty."
        value={environment.job ?? ''}
        onChange={(job) => setEnvironment({ ...environment, job })}
        mono
      />
      <Select
        label="After"
        options={[
          { id: none, label: 'Right after the tag' },
          ...others.map((env) => ({ id: env.name, label: env.name })),
        ]}
        value={environment.after ?? none}
        onChange={(after) => {
          const { after: _old, ...rest } = environment
          setEnvironment(after === none ? rest : { ...rest, after })
        }}
      />
      <Switch
        label="Ask before starting the job"
        isSelected={environment.confirm}
        onChange={(confirm) => setEnvironment({ ...environment, confirm })}
      />
    </Form>
  )
}

function NodeBox({
  icon,
  title,
  detail,
}: {
  icon: ReactNode
  title: ReactNode
  detail?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 truncate text-[12.5px] font-medium">
        <span className="shrink-0 text-muted">{icon}</span>
        <span className="truncate">{title}</span>
      </span>
      {detail ? (
        <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-muted">
          {detail}
        </span>
      ) : null}
    </div>
  )
}

const renderNode = (node: ReleaseFlowNode): ReactNode => {
  if (node.kind === 'branch')
    return (
      <NodeBox
        icon={<GitBranch className="size-3.5" />}
        title={<span className="mono">{node.data.name}</span>}
        detail={
          <>
            {node.data.role === 'source' ? 'source' : 'target'}
            {node.data.role === 'target' && node.data.gated ? <Tag>gates</Tag> : null}
          </>
        }
      />
    )
  if (node.kind === 'request')
    return (
      <NodeBox
        icon={<GitPullRequestArrow className="size-3.5" />}
        title="Release MR"
        detail={node.data.labels.length ? node.data.labels.join(', ') : 'no labels'}
      />
    )
  if (node.kind === 'tag')
    return (
      <NodeBox
        icon={<TagIcon className="size-3.5" />}
        title={<span className="mono">{node.data.example}</span>}
        detail={node.data.scheme === 'semver' ? 'semantic version' : 'calendar version'}
      />
    )
  if (node.kind === 'external')
    return (
      <NodeBox
        icon={<Waypoints className="size-3.5" />}
        title="Tagged outside Holtkeeper"
        detail="external tool"
      />
    )
  return (
    <NodeBox
      icon={<Server className="size-3.5" />}
      title={<span className="mono">{node.data.environment.name}</span>}
      detail={
        <span className="mono">{node.data.environment.job ?? node.data.environment.name}</span>
      }
    />
  )
}

/**
 * The release flow as a diagram drawn from the `releases` setting. People who may configure the
 * repository click a node to edit only that node's fields in the side sheet, turn releases on or
 * off and add environments; each save writes the repository's own `releases` entry.
 */
export function FlowTab({ repo, view }: { repo: RepoRef; view: ReleaseRepoView }) {
  const { settings } = view
  const { save, isPending } = useSaveSettings(repo)
  const graph = releaseFlowGraph(settings, view.row.target)
  const configure = view.can.configure
  const props = { settings, save, pending: isPending }

  const drawer = (node: ReleaseFlowNode): FlowDrawer | undefined => {
    if (!configure) return undefined
    if (node.kind === 'branch')
      return node.data.role === 'source'
        ? { title: 'Source branch', id: node.data.name, content: <SourceForm {...props} /> }
        : { title: 'Target branch', id: node.data.name, content: <TargetForm {...props} /> }
    if (node.kind === 'request')
      return { title: 'Release merge request', content: <RequestForm {...props} /> }
    if (node.kind === 'tag')
      return { title: 'Versions', id: node.data.example, content: <TagForm {...props} /> }
    if (node.kind === 'external')
      return { title: 'External releases', content: <ExternalForm {...props} /> }
    return {
      title: 'Environment',
      id: node.data.environment.name,
      content: <EnvironmentForm {...props} index={node.data.index} />,
    }
  }

  const detection = view.detection
  return (
    <div className="flex flex-col gap-3">
      {configure ? (
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            label="Releases on"
            description="Shown on the Releases overview and refreshed on forge events."
            isSelected={settings.enabled}
            isDisabled={isPending}
            onChange={(enabled) =>
              save({ ...settings, enabled }, enabled ? 'Releases turned on' : 'Releases turned off')
            }
          />
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            isPending={isPending}
            onPress={() => save(addEnvironment(settings), 'Environment added')}
          >
            <Plus className="size-3.5" />
            Environment
          </Button>
        </div>
      ) : null}
      {detection && configure ? (
        <Notice tone="accent" title={`Looks like the ${detection.mode} flow`}>
          <div className="flex flex-col gap-2">
            <span>{detection.reasons.join('; ')}.</span>
            <div>
              <Button
                size="sm"
                variant="secondary"
                isPending={isPending}
                onPress={() =>
                  save(
                    {
                      ...settings,
                      ...(detection.settings as Partial<ReleaseSettings>),
                      enabled: true,
                    },
                    'Detected flow saved and releases turned on',
                  )
                }
              >
                Use it and turn releases on
              </Button>
            </div>
          </div>
        </Notice>
      ) : null}
      <FlowCanvas
        nodes={graph.nodes}
        edges={graph.edges}
        render={renderNode}
        drawer={drawer}
        aria-label={`Release flow of ${repo.path}`}
      />
      <p className="text-xs text-dim">
        {configure
          ? 'Click a step to change it. The release notes style is a Guide rule (section Releases).'
          : 'Your grants do not include settings:write here, so the flow is read-only.'}
      </p>
    </div>
  )
}
