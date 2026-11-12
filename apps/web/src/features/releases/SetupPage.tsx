import type { ReleaseRepoView, ReleaseSettings, RepoRef, SettingView } from '@holtkeeper/api'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, Check, FolderGit2, ListTree, RefreshCw, Save } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  keys,
  useReleaseDetect,
  useReleaseRepo,
  useRepos,
  useResolvedSettings,
  useSettingMutations,
  useSettings,
} from '../../api/queries.ts'
import {
  type SetupStep,
  applyDetection,
  cleanSettings,
  draftErrors,
  fieldSource,
  firstErrorStep,
  flowStrip,
  modeLabels,
  repoReleaseEntry,
  setupSteps,
  signalRows,
  stepOfPath,
} from '../../lib/release-flow.ts'
import { parseRepoKey, repoKey, repoSplat } from '../../lib/repo.ts'
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  LinkButton,
  Notice,
  Page,
  Panel,
  Placeholder,
  Select,
  Switch,
  Tag,
  notify,
} from '../../ui/index.ts'
import {
  EnvironmentFields,
  FlowFields,
  FlowStripView,
  FlowSummary,
  NotifyWebhooks,
  SignalTable,
  VersionFields,
} from './flow-forms.tsx'

const crumbs = (repo?: RepoRef) => [
  { label: 'Flow setup' },
  ...(repo ? [{ label: repo.path }] : []),
]

function PickRepository() {
  const navigate = useNavigate()
  const repos = useRepos()
  const options = (repos.data?.repos ?? [])
    .filter((summary) => summary.configurable)
    .map((summary) => repoKey(summary.repo))
    .toSorted()
    .map((key) => ({ id: key, label: <span className="mono text-xs">{key}</span>, text: key }))
  return (
    <Page crumbs={crumbs()}>
      {repos.isError ? (
        <ErrorState error={repos.error} />
      ) : (
        <EmptyState
          icon={<ListTree />}
          title="Pick a repository"
          description="The setup reads its forge for a suggested flow and saves the repository's own releases settings."
          action={
            <Select
              aria-label="Repository to set up"
              placeholder={repos.isPending ? 'Loading…' : 'Set up a repository…'}
              className="w-72"
              isDisabled={!options.length}
              options={options}
              value={undefined}
              onChange={(key) => void navigate({ to: '/releases/setup', search: { repo: key } })}
            />
          }
        />
      )}
    </Page>
  )
}

function Steps({
  current,
  errors,
  onSelect,
}: {
  current: SetupStep
  errors: Record<string, string>
  onSelect: (step: SetupStep) => void
}) {
  const at = setupSteps.findIndex((step) => step.id === current)
  return (
    <ol aria-label="Setup steps" className="grid gap-2 md:grid-cols-3">
      {setupSteps.map((step, index) => {
        const broken = Object.keys(errors).some((path) => stepOfPath(path) === step.id)
        return (
          <li key={step.id}>
            <button
              type="button"
              aria-current={step.id === current ? 'step' : undefined}
              onClick={() => onSelect(step.id)}
              className={`flex w-full items-center gap-2.5 rounded-[7px] border px-3 py-2 text-left text-[12.5px] ${
                step.id === current ? 'border-accent bg-raise' : 'border-line hover:bg-raise'
              }`}
            >
              <span className="grid size-5 shrink-0 place-items-center rounded-full border border-line text-[11px] tabular">
                {index < at && !broken ? <Check className="size-3" /> : index + 1}
              </span>
              <span className="flex min-w-0 flex-col">
                <b className="font-medium">{step.label}</b>
                <small className="truncate text-muted">{step.hint}</small>
              </span>
              {broken ? (
                <Tag tone="danger" className="ms-auto">
                  fix
                </Tag>
              ) : null}
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel variant="flush" title={title}>
      {children}
    </Panel>
  )
}

function Setup({
  repo,
  view,
  entry,
  configured,
  hooks,
}: {
  repo: RepoRef
  view: ReleaseRepoView
  entry: SettingView | undefined
  configured: boolean
  hooks: readonly SettingView[]
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const client = useQueryClient()
  const { put } = useSettingMutations()
  const [start, setStart] = useState<ReleaseSettings>(view.settings)
  const [draft, setDraft] = useState<ReleaseSettings>(view.settings)
  const [step, setStep] = useState<SetupStep>('flow')
  const [turnOn, setTurnOn] = useState(true)
  const [detect, setDetect] = useState(!configured)
  const detection = useReleaseDetect(repo, detect)
  const found = detection.data?.detection
  const wizard = !configured
  const defaultBranch = view.row.target
  const errors = draftErrors(draft)
  const dirty = JSON.stringify(draft) !== JSON.stringify(start)
  const sourceOf = (path: string) =>
    fieldSource(path, { draft, start, detection: found, configured })
  const props = { draft, onChange: setDraft, sourceOf, errors }

  const readAgain = () => (detect ? void detection.refetch() : setDetect(true))

  const save = (current: ReleaseSettings = draft) => {
    const blocking = firstErrorStep(draftErrors(current))
    if (blocking) {
      setStep(blocking)
      notify.error('Not saved', 'Fix the marked fields first.')
      return
    }
    const value = cleanSettings(
      wizard ? { ...current, enabled: current.enabled || turnOn } : current,
    )
    put.mutate(
      {
        ...(entry ? { id: entry.id } : {}),
        key: 'releases',
        scope: entry?.scope ?? { repos: [repoKey(repo)] },
        value,
      },
      {
        onSuccess: () => {
          void client.invalidateQueries({ queryKey: keys.releases })
          if (wizard) {
            notify.success(value.enabled ? 'Releases set up and turned on' : 'Release flow saved')
            void navigate({ to: '/releases/timeline', search: { repo: repoKey(repo) } })
          } else {
            notify.success('Release flow saved')
            setStart(value)
            setDraft(value)
          }
        },
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )
  }

  const detectPanel = (
    <Section title="Detect">
      {!detect ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted">
            Read the forge (tags, merge requests, labels, files, commits, pipeline jobs) for a
            suggested flow. Nothing is saved until you save.
          </span>
          <Button size="sm" variant="secondary" onPress={readAgain}>
            <RefreshCw className="size-3.5" />
            Read the forge
          </Button>
        </div>
      ) : detection.isPending ? (
        <Placeholder className="h-20" />
      ) : detection.isError ? (
        <Notice tone="danger" title="Could not read the forge">
          {messageOf(detection.error)}
        </Notice>
      ) : found ? (
        <div className="flex flex-col gap-3">
          <Notice
            tone="accent"
            title={`Looks like the ${modeLabels[found.mode].toLowerCase()} flow`}
          >
            <div className="flex flex-col gap-2">
              <span>{found.reasons.join('; ')}.</span>
              <div className="flex flex-wrap gap-2">
                {wizard ? (
                  <Button
                    size="sm"
                    variant="primary"
                    isPending={put.isPending}
                    onPress={() => {
                      const next = { ...applyDetection(draft, found), enabled: true }
                      setDraft(next)
                      save(next)
                    }}
                  >
                    Use it and turn releases on
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => setDraft(applyDetection(draft, found))}
                >
                  {wizard ? 'Review the suggestions first' : 'Use the suggestions'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isPending={detection.isFetching}
                  onPress={readAgain}
                >
                  <RefreshCw className="size-3.5" />
                  Read again
                </Button>
              </div>
            </div>
          </Notice>
        </div>
      ) : null}
    </Section>
  )

  const signalsPanel = found ? (
    <Section title={`What we read · ${signalRows(found).length} signals`}>
      <SignalTable rows={signalRows(found)} />
    </Section>
  ) : null

  const strip = (
    <Section title="Flow">
      <FlowStripView
        groups={flowStrip(draft, defaultBranch)}
        sourceOf={sourceOf}
        onSelect={wizard ? (item) => setStep(item.step) : undefined}
      />
    </Section>
  )

  const flowFields = (
    <FlowFields
      {...props}
      defaultBranch={defaultBranch}
      labelSuggestions={found?.signals.releaseLabels.map((label) => label.name) ?? []}
    />
  )
  const deploy = (
    <div className="flex flex-col gap-4">
      <EnvironmentFields {...props} />
      <NotifyWebhooks entries={hooks} />
    </div>
  )

  const more = [
    {
      label: 'Read the forge again',
      icon: RefreshCw,
      onAction: readAgain,
      isDisabled: detection.isFetching,
    },
    {
      label: 'Open repository',
      icon: FolderGit2,
      href: router.buildLocation({ to: '/repos/$', params: { _splat: repoSplat(repo) } }).href,
    },
    ...(wizard
      ? []
      : [{ label: 'Start over', onAction: () => setDraft(start), isDisabled: !dirty }]),
  ]

  const at = setupSteps.findIndex((item) => item.id === step)
  const previous = setupSteps[at - 1]
  const next = setupSteps[at + 1]

  return (
    <Page
      crumbs={crumbs(repo)}
      more={more}
      actions={
        <>
          {wizard ? (
            <Tag>
              Step {at + 1} of {setupSteps.length}
            </Tag>
          ) : (
            <Tag tone={dirty ? 'accent' : 'default'}>{dirty ? 'Unsaved changes' : 'Saved'}</Tag>
          )}
          <LinkButton
            to={wizard ? '/releases' : '/releases/timeline'}
            search={wizard ? {} : { repo: repoKey(repo) }}
            variant="ghost"
            size="sm"
          >
            {wizard ? 'Cancel setup' : 'Timeline'}
          </LinkButton>
        </>
      }
      {...(wizard
        ? {}
        : {
            primary: {
              label: 'Save',
              icon: Save,
              onPress: () => save(),
              isDisabled: !dirty || put.isPending,
            },
          })}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{wizard ? 'Setting up releases for' : 'Release flow of'}</span>
          <Link
            to="/releases/timeline"
            search={{ repo: repoKey(repo) }}
            className="mono text-foreground underline-offset-2 hover:underline"
          >
            {repo.path}
          </Link>
          <span className="ms-auto">
            Saves the repository's own <span className="mono">releases</span> settings entry ·
            nothing is tagged or deployed
          </span>
        </div>
        {view.readOnly ? (
          <Notice tone="warning" title="Read-only repository">
            Holtkeeper only reads this repository; steps and deploys stay off whatever the flow
            says.
          </Notice>
        ) : null}
        {wizard ? <Steps current={step} errors={errors} onSelect={setStep} /> : null}
        {detectPanel}
        {signalsPanel}
        {strip}
        {wizard ? (
          <Section title={setupSteps[at]?.label ?? ''}>
            {step === 'flow' ? (
              flowFields
            ) : step === 'versions' ? (
              <VersionFields {...props} />
            ) : (
              deploy
            )}
          </Section>
        ) : (
          <>
            <Section title="Releases">
              <Switch
                label="Releases on"
                description="Shown on the Releases overview and refreshed on forge events."
                isSelected={draft.enabled}
                onChange={(enabled) => setDraft({ ...draft, enabled })}
              />
            </Section>
            <Section title="Flow">{flowFields}</Section>
            <Section title="Versions and changelog">
              <VersionFields {...props} />
            </Section>
            <Section title="Environments">{deploy}</Section>
          </>
        )}
        {wizard ? (
          <footer className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
            <Checkbox
              label="Turn releases on when I finish"
              isSelected={turnOn}
              onChange={setTurnOn}
            />
            <span className="text-xs text-muted">
              It then shows on the Releases overview and refreshes on forge events
            </span>
            <span className="flex-1" />
            {previous ? (
              <Button variant="ghost" size="sm" onPress={() => setStep(previous.id)}>
                <ArrowLeft className="size-3.5" />
                Back to {previous.label.toLowerCase()}
              </Button>
            ) : null}
            {next ? (
              <Button variant="primary" size="sm" onPress={() => setStep(next.id)}>
                Continue to {next.label.toLowerCase()}
                <ArrowRight className="size-3.5" />
              </Button>
            ) : (
              <Button variant="primary" size="sm" isPending={put.isPending} onPress={() => save()}>
                <Save className="size-3.5" />
                Save the flow
              </Button>
            )}
          </footer>
        ) : null}
      </div>
    </Page>
  )
}

function ReadOnly({ repo, view }: { repo: RepoRef; view: ReleaseRepoView }) {
  return (
    <Page crumbs={crumbs(repo)}>
      <div className="flex flex-col gap-4">
        <Notice title="Read-only">
          Your grants do not include settings:write for {repo.path}, so its release flow is shown
          but cannot be changed here.
        </Notice>
        <FlowSummary settings={view.settings} defaultBranch={view.row.target} />
      </div>
    </Page>
  )
}

function Loaded({ repo }: { repo: RepoRef }) {
  const view = useReleaseRepo(repo)
  const configure = view.data?.can.configure === true
  const resolved = useResolvedSettings(configure ? repo : undefined)
  const settings = useSettings(configure)
  if (view.isError)
    return (
      <Page crumbs={crumbs(repo)}>
        <ErrorState error={view.error} />
      </Page>
    )
  if (resolved.isError)
    return (
      <Page crumbs={crumbs(repo)}>
        <ErrorState error={resolved.error} />
      </Page>
    )
  if (!view.data || (configure && !resolved.data))
    return (
      <Page crumbs={crumbs(repo)}>
        <div className="flex flex-col gap-3">
          <Placeholder className="h-24" />
          <Placeholder className="h-64" />
        </div>
      </Page>
    )
  if (!configure || !resolved.data) return <ReadOnly repo={repo} view={view.data} />
  const cascade = resolved.data.cascade['releases'] ?? []
  return (
    <Setup
      repo={repo}
      view={view.data}
      entry={repoReleaseEntry(cascade, repo)}
      configured={cascade.length > 0}
      hooks={(settings.data?.settings ?? []).filter((entry) => entry.key === 'releases.notify')}
    />
  )
}

/**
 * Release flow setup of one repository (`/releases/setup?repo=`). A repository without a
 * `releases` setting gets three steps (flow, versions, environments) over a draft kept in the
 * page, with the forge's detected flow offered as suggestions, and one save at the end; a
 * configured one gets every section on one page with a single Save. Without `settings:write`
 * the flow is shown read-only; without `repo` the page asks for a repository.
 */
export function SetupPage() {
  const search = useSearch({ strict: false })
  const repo = parseRepoKey(search.repo)
  if (!repo) return <PickRepository />
  return <Loaded key={repoKey(repo)} repo={repo} />
}
