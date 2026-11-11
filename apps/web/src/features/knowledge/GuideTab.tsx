import type {
  Family,
  GuideGenerated,
  GuideScopeKey,
  GuideSection,
  PersonView,
} from '@holtkeeper/api'
import { ExternalLink, History, Pencil, RefreshCw } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useGuide, useGuideMutations } from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import {
  type Space,
  guideSections,
  isGeneratedSection,
  isSteerableSection,
  pendingGenerated,
  sectionIsEmpty,
  sectionPolicies,
  spaceKey,
} from '../../lib/guide.ts'
import {
  Button,
  ErrorState,
  Markdown,
  Placeholder,
  Tag,
  TextField,
  Tooltip,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { HistorySheet } from './HistorySheet.tsx'
import { Byline, MarkdownEditor } from './parts.tsx'
import { PolicyBlock } from './PolicyBlock.tsx'

/** The Guide of a space: one card per section with team rules, steering, generated text and policy. */
export function GuideTab({ space, families }: { space: Space; families: readonly Family[] }) {
  const scope = spaceKey(space)
  const guide = useGuide(scope)
  const [history, setHistory] = useState<GuideSection | null>(null)
  const members =
    space.kind === 'family' ? (families.find((f) => f.id === space.family)?.members ?? []) : []

  if (guide.isPending)
    return (
      <div className="flex flex-col gap-3">
        <Placeholder className="h-40" />
        <Placeholder className="h-40" />
      </div>
    )
  if (guide.isError) return <ErrorState error={guide.error} />

  const { sections, canEdit, people } = guide.data
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        Rules files in the repository (AGENTS.md, REVIEW.md) come first, then team rules from the
        most specific space to All. Generated text is lower priority: agents ignore lines that
        conflict with anything above it.
        {canEdit ? null : ' You can read this Guide but not edit it.'}
      </p>
      {sections.map((section) => (
        <SectionCard
          key={`${scope}/${section.section}/${section.version}`}
          scope={scope}
          space={space}
          section={section}
          canEdit={canEdit}
          people={people}
          members={members}
          onHistory={() => setHistory(section)}
        />
      ))}
      {history ? (
        <HistorySheet scope={scope} section={history.section} onClose={() => setHistory(null)} />
      ) : null}
    </div>
  )
}

function SectionCard({
  scope,
  space,
  section,
  canEdit,
  people,
  members,
  onHistory,
}: {
  scope: GuideScopeKey
  space: Space
  section: GuideSection
  canEdit: boolean
  people: Readonly<Record<string, PersonView>>
  members: readonly string[]
  onHistory: () => void
}) {
  const meta = guideSections.find((s) => s.id === section.section)
  const { save } = useGuideMutations()
  const [rules, setRules] = useState<string | null>(null)
  const [steering, setSteering] = useState(section.steering)
  const steers = isSteerableSection(section.section)
  const policy = sectionPolicies[section.section]
  const pending = pendingGenerated(section)

  const put = (next: { rules: string; steering: string }, done: string) =>
    save.mutate(
      {
        scope,
        section: section.section,
        input: { ...next, version: section.version },
      },
      {
        onSuccess: () => {
          notify.success(done, meta?.label)
          setRules(null)
        },
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )

  return (
    <section
      aria-label={meta?.label ?? section.section}
      className="flex flex-col gap-4 rounded-2xl border border-line bg-panel p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold">
            {meta?.label ?? section.section}
            {sectionIsEmpty(section) ? <Tag>empty</Tag> : null}
            {pending ? (
              <Tag tone="warning" dot>
                proposal waiting
              </Tag>
            ) : null}
          </h2>
          <p className="text-xs text-muted">{meta?.hint}</p>
        </div>
        {section.version > 0 ? (
          <Button variant="ghost" size="sm" onPress={onHistory}>
            <History className="size-3.5" />
            History
            <span className="mono text-dim">v{section.version}</span>
          </Button>
        ) : null}
      </header>

      <Layer
        title="Team rules"
        aside={
          rules === null ? (
            <Byline verb="edited" id={section.editedBy} at={section.editedAt} people={people} />
          ) : null
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
                onPress={() => put({ rules, steering: section.steering }, 'Rules saved')}
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
              <span className="text-sm text-muted">No team rules for this section.</span>
            )}
            {canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={`Edit ${meta?.label ?? section.section} rules`}
                onPress={() => setRules(section.rules)}
              >
                <Pencil className="size-3.5" />
              </Button>
            ) : null}
          </div>
        )}
      </Layer>

      {section.learnings.length ? (
        <Layer title="Learned rules">
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
        </Layer>
      ) : null}

      {steers ? (
        <Layer title="Steering" aside={<span className="text-xs text-dim">generator only</span>}>
          {canEdit ? (
            <div className="flex items-end gap-2">
              <TextField
                aria-label={`${meta?.label ?? section.section} steering`}
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
                onPress={() => put({ rules: section.rules, steering }, 'Steering saved')}
              >
                Save
              </Button>
            </div>
          ) : (
            <span className="text-sm text-muted">{section.steering || 'No steering.'}</span>
          )}
        </Layer>
      ) : null}

      {steers && space.kind === 'repo' ? (
        <GeneratedLayer scope={scope} space={space} section={section} canEdit={canEdit} />
      ) : null}

      {policy ? <PolicyBlock settingKey={policy} space={space} members={members} /> : null}
    </section>
  )
}

function Layer({
  title,
  aside,
  children,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  )
}

function GeneratedMeta({ generated }: { generated: GuideGenerated }) {
  return (
    <span className="mono flex flex-wrap items-center gap-x-2 text-xs text-muted">
      <span>{generated.model}</span>
      <span>{formatUsd(generated.costUsd)}</span>
      <span title={formatDateTime(generated.generatedAt)}>
        {formatRelative(generated.generatedAt)}
      </span>
      {generated.sha ? <span>{generated.sha.slice(0, 8)}</span> : null}
    </span>
  )
}

function GeneratedLayer({
  scope,
  space,
  section,
  canEdit,
}: {
  scope: GuideScopeKey
  space: Extract<Space, { kind: 'repo' }>
  section: GuideSection
  canEdit: boolean
}) {
  const { can } = useSession()
  const { accept, regenerate } = useGuideMutations()
  const [prompt, setPrompt] = useState<string | null>(null)
  const pending = pendingGenerated(section)
  const generated = section.generated
  const name = section.section
  const canRegenerate = canEdit && can('analyses:run') && isGeneratedSection(name)

  const acceptPending = () =>
    pending &&
    accept.mutate(
      { scope, section: name, inputHash: pending.inputHash },
      {
        onSuccess: () => notify.success('Generated text accepted'),
        onError: (error) => notify.error('Not accepted', messageOf(error)),
      },
    )

  const queue = () =>
    isGeneratedSection(name) &&
    regenerate.mutate(
      {
        repo: space.repo,
        input: { sections: [name], ...(prompt?.trim() ? { prompt: prompt.trim() } : {}) },
      },
      {
        onSuccess: (job) => {
          notify.success('Regeneration queued', `Job ${job.id}`)
          setPrompt(null)
        },
        onError: (error) => notify.error('Not queued', messageOf(error)),
      },
    )

  return (
    <Layer
      title="Generated"
      aside={
        canRegenerate && prompt === null ? (
          <Button variant="ghost" size="sm" onPress={() => setPrompt('')}>
            <RefreshCw className="size-3.5" />
            Regenerate
          </Button>
        ) : null
      }
    >
      <p className="text-xs text-dim">
        Lower priority than team rules. Written by the guide job from repository signals.
      </p>
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
      {generated ? (
        <GeneratedBody
          generated={generated}
          label={generated.status === 'accepted' ? 'accepted' : 'proposed'}
        />
      ) : (
        <span className="text-sm text-muted">Nothing generated yet.</span>
      )}
      {section.proposal ? (
        <GeneratedBody generated={section.proposal} label="new proposal" />
      ) : null}
      {pending && canEdit ? (
        <div className="flex justify-end">
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
    </Layer>
  )
}

function GeneratedBody({ generated, label }: { generated: GuideGenerated; label: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-raise p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={label === 'accepted' ? 'success' : 'warning'} dot>
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
