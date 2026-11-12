import type {
  GuideChainLayer,
  GuideGenerated,
  GuideScopeKey,
  GuideSection,
  PersonView,
  RepoRef,
} from '@holtkeeper/api'
import { parentGroup } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ExternalLink, GitCompare, History, Pencil, RefreshCw, RotateCcw } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useGroupTitles,
  useGuideChain,
  useGuideMutations,
  useGuideRepoFiles,
  useGuideSection,
  useKnowledgeCounts,
} from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { formatDateTime, formatRelative, plural, shortId, shortSha } from '../../lib/format.ts'
import { groupPathTitle } from '../../lib/group-titles.ts'
import {
  type Space,
  guideSections,
  isGeneratedSection,
  isSteerableSection,
  layerBody,
  layerKinds,
  layerSlots,
  parseSpace,
  pendingGenerated,
  sectionPolicies,
  spaceCounts,
  spaceKey,
} from '../../lib/guide.ts'
import {
  Button,
  ErrorState,
  LinkButton,
  Markdown,
  Placeholder,
  Tag,
  TextField,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { BudgetBar, Warnings, charsOf } from './EffectivePrompt.tsx'
import { GeneratedCompare } from './GeneratedCompare.tsx'
import { Byline, MarkdownEditor } from './parts.tsx'
import { PolicyBlock } from './PolicyBlock.tsx'

interface SectionProps {
  space: Space
  scope: GuideScopeKey
  section: GuideSection
  canEdit: boolean
  people: Readonly<Record<string, PersonView>>
  /** Members of the family space, for policy entries. */
  members: readonly string[]
}

/**
 * One Guide section in detail: its layers numbered in the order agents read them (from the
 * repository's chain, with the 12k budget of the whole prompt of the section's task), this space's rules to edit, learned rules,
 * steering, generated text with Compare, and the section's policy. Revisions open inline.
 */
export function SectionDetail(props: SectionProps) {
  const { space, scope, section } = props
  const meta = guideSections.find((s) => s.id === section.section)
  const [history, setHistory] = useState(false)
  return (
    <section
      aria-label={`${meta?.label ?? section.section} section`}
      className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">{meta?.label ?? section.section}</h2>
          <p className="text-xs text-muted">{meta?.hint}</p>
        </div>
        {section.version > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={history}
            onPress={() => setHistory((open) => !open)}
          >
            <History className="size-3.5" />
            History
            <span className="mono text-dim">v{section.version}</span>
          </Button>
        ) : null}
      </header>
      {history ? <Revisions scope={scope} section={section} /> : null}
      <p className="text-xs text-muted">
        Agents read the layers top to bottom. When two lines disagree the higher layer wins, and
        people&apos;s rules always win over generated text.
      </p>
      {space.kind === 'repo' ? (
        <RepoLayers {...props} repo={space.repo} />
      ) : (
        <ScopeLayers {...props} />
      )}
      {sectionPolicies[section.section] ? (
        <PolicyBlock
          settingKey={sectionPolicies[section.section] ?? ''}
          space={space}
          members={props.members}
        />
      ) : null}
    </section>
  )
}

function LayerRow({
  n,
  letter,
  kind,
  title,
  aside,
  children,
}: {
  n: number | undefined
  letter: string
  /** What the letter stands for, for screen readers and the tooltip. */
  kind: string
  title: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 border-t border-line pt-3">
      <span
        aria-label={n === undefined ? 'Not set' : `Layer ${n}`}
        className="mono grid size-6 place-items-center rounded-md border border-line text-[11px] text-muted"
      >
        {n ?? '–'}
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex min-w-0 items-center gap-2 text-[12.5px] font-medium">
            <Tag mono title={kind} aria-label={kind}>
              {letter}
            </Tag>
            <span className="min-w-0 truncate">{title}</span>
          </h3>
          {aside}
        </div>
        {children}
      </div>
    </li>
  )
}

const chars = (layer: GuideChainLayer) => (
  <span className="mono flex items-center gap-1.5 text-xs text-muted">
    {layer.cut ? <Tag tone="danger">cut</Tag> : null}
    {charsOf(layer)}
  </span>
)

/** "N candidates in Learnings" for the space, linking to them; nothing while none waits. */
function CandidatesLink({ space }: { space: Space }) {
  const counts = useKnowledgeCounts()
  const waiting = spaceCounts(counts.data, space).learnings
  if (!waiting) return null
  return (
    <Link
      to="/knowledge/learnings"
      search={{ space: spaceKey(space) }}
      className="text-xs text-muted hover:text-foreground hover:underline"
    >
      {plural(waiting, 'candidate')} in Learnings
    </Link>
  )
}

function RepoLayers(props: SectionProps & { repo: RepoRef }) {
  const { repo, section } = props
  const chain = useGuideChain(repo, section.section)
  if (chain.isPending) return <Placeholder className="h-48" />
  if (chain.isError) return <ErrorState error={chain.error} />
  const layers = chain.data.sections[0]?.layers ?? []
  const slots = layerSlots(layers, { generated: isGeneratedSection(section.section) })
  return (
    <>
      <p className="text-xs text-dim">
        Budget of the whole prompt this section goes into, with the other sections its task reads.
      </p>
      <BudgetBar budget={chain.data.budget} />
      <Warnings warnings={chain.data.warnings} />
      <ol className="flex flex-col gap-3">
        {slots.map((slot) => {
          if ('empty' in slot)
            return slot.empty === 'repo' ? (
              <OwnRules key="repo" {...props} n={undefined} kind="repo" />
            ) : (
              <GeneratedRow key="generated" {...props} repo={repo} n={undefined} />
            )
          const { layer } = slot
          if (layer.kind === 'repo')
            return (
              <OwnRules key={layer.n} {...props} n={layer.n} kind="repo" aside={chars(layer)} />
            )
          if (layer.kind === 'generated')
            return <GeneratedRow key={layer.n} {...props} repo={repo} n={layer.n} layer={layer} />
          if (layer.kind === 'repo-file')
            return (
              <LayerRow
                key={layer.n}
                n={layer.n}
                letter={layerKinds['repo-file'].letter}
                kind={layerKinds['repo-file'].label}
                title={`Repository files · ${layer.source}`}
                aside={chars(layer)}
              >
                <RepoFiles repo={repo} />
              </LayerRow>
            )
          return (
            <LayerRow
              key={layer.n}
              n={layer.n}
              letter={layerKinds[layer.kind].letter}
              kind={layerKinds[layer.kind].label}
              title={layer.source}
              aside={
                <span className="flex items-center gap-2">
                  {layer.kind === 'learnings' ? <CandidatesLink space={props.space} /> : null}
                  {chars(layer)}
                  {layer.scope ? <SpaceLink scope={layer.scope} section={section.section} /> : null}
                </span>
              }
            >
              <Markdown text={layerBody(layer.text) || '—'} className="text-muted" />
            </LayerRow>
          )
        })}
        <Steering {...props} />
      </ol>
    </>
  )
}

function ScopeLayers(props: SectionProps) {
  const { space, section } = props
  const titleOf = useGroupTitles()
  const parent = space.kind === 'group' ? parentGroup(space.group) : undefined
  const after = parent === undefined ? 2 : 3
  return (
    <>
      {space.kind !== 'all' ? (
        <p className="text-xs text-dim">
          The 12,000-character budget applies per repository: open a repository to see its layers
          and what fits.
        </p>
      ) : null}
      <ol className="flex flex-col gap-3">
        <OwnRules
          {...props}
          n={1}
          kind={
            space.kind === 'family'
              ? 'family'
              : space.kind === 'group'
                ? parent === undefined
                  ? 'group'
                  : 'subgroup'
                : 'all'
          }
        />
        {parent !== undefined ? (
          <LayerRow
            n={2}
            letter={layerKinds.group.letter}
            kind={layerKinds.group.label}
            title={`Team ${groupPathTitle(titleOf, parent)}`}
            aside={<SpaceLink scope={`group:${parent}`} section={section.section} />}
          >
            <span className="text-xs text-muted">
              The parent team&apos;s rules come after this subgroup&apos;s rules.
            </span>
          </LayerRow>
        ) : null}
        {space.kind !== 'all' ? (
          <LayerRow
            n={after}
            letter={layerKinds.all.letter}
            kind={layerKinds.all.label}
            title="All repositories"
            aside={<SpaceLink scope="all" section={section.section} />}
          >
            <span className="text-xs text-muted">
              Rules for every repository come after this space&apos;s rules.
            </span>
          </LayerRow>
        ) : null}
        {section.learnings.length ? (
          <LayerRow
            n={space.kind !== 'all' ? after + 1 : 2}
            letter={layerKinds.learnings.letter}
            kind={layerKinds.learnings.label}
            title="Learned rules"
            aside={<CandidatesLink space={space} />}
          >
            <Learnings section={section} people={props.people} />
          </LayerRow>
        ) : null}
        <Steering {...props} />
      </ol>
    </>
  )
}

function SpaceLink({ scope, section }: { scope: GuideScopeKey; section: GuideSection['section'] }) {
  if (!parseSpace(scope)) return null
  return (
    <Link
      to="/knowledge/guide"
      search={{ space: scope, section }}
      className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
    >
      Open
      <ExternalLink className="size-3" />
    </Link>
  )
}

function RepoFiles({ repo }: { repo: RepoRef }) {
  const files = useGuideRepoFiles(repo)
  if (files.isPending) return <Placeholder className="h-10" />
  if (files.isError) return <ErrorState error={files.error} />
  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      <span>
        Read-only: read from the default branch
        {files.data.sha ? (
          <>
            {' '}
            at <span className="mono">{shortSha(files.data.sha)}</span>
          </>
        ) : null}
        ; change them in the repository.
      </span>
      <ul className="flex flex-col gap-0.5">
        {files.data.files.map((file) => (
          <li key={file.path} className="flex flex-wrap items-center gap-2">
            <span className="mono text-foreground" title={file.sha}>
              {file.path}
            </span>
            <span className="mono">{file.text.split('\n').length} lines</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function OwnRules({
  space,
  scope,
  section,
  canEdit,
  people,
  n,
  kind,
  aside,
}: SectionProps & {
  n: number | undefined
  kind: 'repo' | 'family' | 'subgroup' | 'group' | 'all'
  aside?: ReactNode
}) {
  const titleOf = useGroupTitles()
  const { save } = useGuideMutations()
  const [rules, setRules] = useState<string | null>(null)
  const label =
    space.kind === 'repo'
      ? 'This repository'
      : space.kind === 'all'
        ? 'All repositories'
        : space.kind === 'group'
          ? `Team ${groupPathTitle(titleOf, space.group)}`
          : 'This family'

  const put = () =>
    rules !== null &&
    save.mutate(
      {
        scope,
        section: section.section,
        input: { rules, steering: section.steering, version: section.version },
      },
      {
        onSuccess: () => {
          notify.success('Rules saved')
          setRules(null)
        },
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )

  return (
    <LayerRow
      n={n}
      letter={layerKinds[kind].letter}
      kind={layerKinds[kind].label}
      title={
        <>
          {label}
          {rules !== null ? (
            <span className="ml-2 text-xs text-warn">Editing · unsaved</span>
          ) : null}
        </>
      }
      aside={
        <span className="flex items-center gap-2">
          {rules === null ? (
            <Byline verb="edited" id={section.editedBy} at={section.editedAt} people={people} />
          ) : null}
          {aside}
        </span>
      }
    >
      {rules !== null ? (
        <div className="flex flex-col gap-2">
          <MarkdownEditor
            label="Team rules"
            value={rules}
            onChange={setRules}
            placeholder="- Prefer the shared fooUtil over hand-written date math."
            description="Markdown. Agents follow these rules over anything generated."
          />
          <div className="flex justify-end gap-2">
            <Button variant="tertiary" size="sm" onPress={() => setRules(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              isPending={save.isPending}
              isDisabled={rules.trim() === section.rules}
              onPress={put}
            >
              Save rules
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          {section.rules.trim() ? (
            <Markdown text={section.rules} className="min-w-0" />
          ) : (
            <span className="text-sm text-muted">No team rules here for this section.</span>
          )}
          {canEdit ? (
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label="Edit rules"
              onPress={() => setRules(section.rules)}
            >
              <Pencil className="size-3.5" />
            </Button>
          ) : null}
        </div>
      )}
    </LayerRow>
  )
}

function Learnings({
  section,
  people,
}: {
  section: GuideSection
  people: Readonly<Record<string, PersonView>>
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {section.learnings.map((learning) => (
        <li key={learning.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="min-w-0 flex-1">{learning.rule}</span>
          {learning.sources.slice(0, 3).map((source, index) =>
            source.url ? (
              <a
                key={`${source.label}-${index}`}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="mono inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
              >
                {source.label}
                <ExternalLink className="size-3" />
              </a>
            ) : (
              <span key={`${source.label}-${index}`} className="mono text-xs text-muted">
                {source.label}
              </span>
            ),
          )}
          <Byline
            verb="accepted"
            id={learning.acceptedBy}
            at={learning.acceptedAt}
            people={people}
          />
        </li>
      ))}
    </ul>
  )
}

function Steering({ scope, section, canEdit }: SectionProps) {
  const { save } = useGuideMutations()
  const [steering, setSteering] = useState(section.steering)
  if (!isSteerableSection(section.section)) return null
  return (
    <LayerRow
      n={undefined}
      letter="S"
      kind="Steering"
      title="Steering"
      aside={<span className="text-xs text-dim">generator only · not sent to agents</span>}
    >
      {canEdit ? (
        <div className="flex items-end gap-2">
          <TextField
            aria-label="Steering"
            value={steering}
            onChange={setSteering}
            placeholder="e.g. Focus on the API layer; ignore the legacy folder."
            className="min-w-0 flex-1"
          />
          <Button
            variant="secondary"
            size="sm"
            isPending={save.isPending}
            isDisabled={steering.trim() === section.steering}
            onPress={() =>
              save.mutate(
                {
                  scope,
                  section: section.section,
                  input: { rules: section.rules, steering, version: section.version },
                },
                {
                  onSuccess: () => notify.success('Steering saved'),
                  onError: (error) => notify.error('Not saved', messageOf(error)),
                },
              )
            }
          >
            Save
          </Button>
        </div>
      ) : (
        <span className="text-sm text-muted">{section.steering || 'No steering.'}</span>
      )}
    </LayerRow>
  )
}

function GeneratedMeta({ generated }: { generated: GuideGenerated }) {
  return (
    <span className="mono flex flex-wrap items-center gap-x-2 text-xs text-muted">
      {generated.version ? <span>v{generated.version}</span> : null}
      <span>{generated.model}</span>
      <span>{formatUsd(generated.costUsd)}</span>
      <span title={formatDateTime(generated.generatedAt)}>
        {formatRelative(generated.generatedAt)}
      </span>
      {generated.sha ? <span>{shortSha(generated.sha)}</span> : null}
      {generated.jobId ? (
        <Link
          to="/ops/runs/$jobId"
          params={{ jobId: generated.jobId }}
          className="hover:text-foreground"
        >
          {shortId(generated.jobId)}
        </Link>
      ) : null}
    </span>
  )
}

function GeneratedText({ generated, label }: { generated: GuideGenerated; label: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-raise p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={label === 'Accepted' ? 'success' : 'warning'} dot>
          {label}
        </Tag>
        <GeneratedMeta generated={generated} />
      </div>
      <Markdown text={generated.body} className="text-muted" />
      {generated.prompt ? (
        <span className="text-xs text-dim">Extra prompt: {generated.prompt}</span>
      ) : null}
    </div>
  )
}

function GeneratedRow({
  scope,
  section,
  canEdit,
  repo,
  n,
  layer,
}: SectionProps & { repo: RepoRef; n: number | undefined; layer?: GuideChainLayer }) {
  const { can } = useSession()
  const { accept, reject, regenerate } = useGuideMutations()
  const [prompt, setPrompt] = useState<string | null>(null)
  const [compare, setCompare] = useState(false)
  const pending = pendingGenerated(section)
  const name = section.section
  const canRegenerate = canEdit && can('analyses:run') && isGeneratedSection(name)
  const versions = [section.generated?.version ?? 0, section.proposal?.version ?? 0]

  const acceptPending = () =>
    pending &&
    accept.mutate(
      { scope, section: name, inputHash: pending.inputHash },
      {
        onSuccess: () => notify.success('Generated text accepted'),
        onError: (error) => notify.error('Not accepted', messageOf(error)),
      },
    )

  const rejectPending = () =>
    pending &&
    reject.mutate(
      { scope, section: name, inputHash: pending.inputHash },
      {
        onSuccess: () => notify.success('Proposal rejected'),
        onError: (error) => notify.error('Not rejected', messageOf(error)),
      },
    )

  const queue = () =>
    isGeneratedSection(name) &&
    regenerate.mutate(
      { repo, input: { sections: [name], ...(prompt?.trim() ? { prompt: prompt.trim() } : {}) } },
      {
        onSuccess: (job) => {
          notify.success('Regeneration queued', `Job ${job.id}`)
          setPrompt(null)
        },
        onError: (error) => notify.error('Not queued', messageOf(error)),
      },
    )

  return (
    <LayerRow
      n={n}
      letter={layerKinds.generated.letter}
      kind={layerKinds.generated.label}
      title={
        <>
          Generated
          <span className="ml-2 text-xs font-normal text-dim">
            lower priority · written by the guide job from repository signals
          </span>
        </>
      }
      aside={
        <span className="flex items-center gap-2">
          {layer ? chars(layer) : null}
          {Math.max(...versions) > 1 ? (
            <Button variant="ghost" size="sm" onPress={() => setCompare((open) => !open)}>
              <GitCompare className="size-3.5" />
              Compare
            </Button>
          ) : null}
          {canRegenerate && prompt === null ? (
            <Button variant="ghost" size="sm" onPress={() => setPrompt('')}>
              <RefreshCw className="size-3.5" />
              Regenerate
            </Button>
          ) : null}
        </span>
      }
    >
      {prompt !== null ? (
        <div className="flex items-end gap-2">
          <TextField
            aria-label="Extra prompt for this run"
            value={prompt}
            onChange={setPrompt}
            placeholder="Optional extra prompt for this run only"
            className="min-w-0 flex-1"
          />
          <Button variant="tertiary" size="sm" onPress={() => setPrompt(null)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" isPending={regenerate.isPending} onPress={queue}>
            Queue
          </Button>
        </div>
      ) : null}
      {compare ? (
        <GeneratedCompare scope={scope} section={name} onClose={() => setCompare(false)} />
      ) : null}
      {section.proposal ? <GeneratedText generated={section.proposal} label="Proposed" /> : null}
      {section.generated ? (
        <GeneratedText
          generated={section.generated}
          label={section.generated.status === 'accepted' ? 'Accepted' : 'Proposed'}
        />
      ) : (
        <span className="text-sm text-muted">Nothing generated yet.</span>
      )}
      {pending && canEdit ? (
        <div className="flex flex-wrap justify-end gap-2">
          <LinkButton to="/inbox" search={{ kind: 'guide' }} variant="ghost" size="sm">
            Decide in Inbox
          </LinkButton>
          <Button
            variant="secondary"
            size="sm"
            isPending={reject.isPending}
            onPress={rejectPending}
          >
            Reject
          </Button>
          <Tooltip content="Agents see accepted text; a proposal waits for a person">
            <Button
              variant="primary"
              size="sm"
              isPending={accept.isPending}
              onPress={acceptPending}
            >
              Accept {section.proposal ? 'proposal' : 'text'}
            </Button>
          </Tooltip>
        </div>
      ) : null}
    </LayerRow>
  )
}

function Revisions({ scope, section }: { scope: GuideScopeKey; section: GuideSection }) {
  const detail = useGuideSection(scope, section.section)
  const { restore } = useGuideMutations()
  if (detail.isPending) return <Placeholder className="h-24" />
  if (detail.isError) return <ErrorState error={detail.error} />
  return (
    <ol
      aria-label="Revisions"
      className="flex flex-col gap-2 rounded-lg border border-line bg-raise p-3"
    >
      {detail.data.history.map((revision) => (
        <li
          key={revision.version}
          className="flex flex-col gap-1.5 border-b border-line pb-2 last:border-0 last:pb-0"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Tag mono>v{revision.version}</Tag>
            <Byline
              verb="edited"
              id={revision.editedBy}
              at={revision.editedAt}
              people={detail.data.people}
            />
            {detail.data.canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                isPending={restore.isPending && restore.variables?.version === revision.version}
                onPress={() =>
                  restore.mutate(
                    { scope, section: section.section, version: revision.version },
                    {
                      onSuccess: () => notify.success('Revision restored', `v${revision.version}`),
                      onError: (error) => notify.error('Not restored', messageOf(error)),
                    },
                  )
                }
              >
                <RotateCcw className="size-3.5" />
                Restore
              </Button>
            ) : null}
          </div>
          {revision.rules.trim() ? (
            <Markdown text={revision.rules} className="text-muted" />
          ) : (
            <span className="text-sm text-dim">No team rules.</span>
          )}
          {revision.steering ? (
            <span className="text-xs text-muted">Steering: {revision.steering}</span>
          ) : null}
        </li>
      ))}
      {detail.data.history.length === 0 ? (
        <li className="text-sm text-muted">No earlier revisions.</li>
      ) : null}
    </ol>
  )
}
