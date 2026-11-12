import type { MediaApplyResult, MediaVariantsResult, RepoRef } from '@holtkeeper/api'
import { ImageDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { ApiError, messageOf } from '../../api/client.ts'
import { useMediaMutations } from '../../api/queries.ts'
import {
  type MediaDraft,
  type MediaStep,
  configSummary,
  conflictIds,
  deliverBlocker,
  duplicatePaths,
  emptyMediaDraft,
  initialSelection,
  mediaFormats,
  mediaPresets,
  mediaSteps,
  mediaTitle,
  offeredVariants,
  replacementOf,
  stepState,
  toVariantsInput,
  validateDensity,
  validateMediaDraft,
  validateWidth,
} from '../../lib/media.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import {
  Button,
  KeyValue,
  MultiToggle,
  Notice,
  Segmented,
  Select,
  SideSheet,
  TagInput,
  TextField,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { MediaMarkup, MediaVariants } from './MediaVariants.tsx'

/** What the optimizer opens on: a repository (else picked in the sheet), a file and a ref. */
export interface MediaTarget {
  repo?: RepoRef
  file?: string
  ref?: string
}

const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Stepper({ current }: { current: MediaStep }) {
  return (
    <ol className="m-0 grid list-none grid-cols-4 gap-1 p-0">
      {mediaSteps.map((step, index) => {
        const state = stepState(step.id, current)
        return (
          <li
            key={step.id}
            {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
            className={`flex flex-col gap-1.5 text-[11.5px] ${state === 'current' ? 'font-medium text-foreground' : 'text-muted'}`}
          >
            <i
              aria-hidden
              className={`block h-1 rounded-sm ${state === 'done' ? 'bg-ok' : state === 'current' ? 'bg-foreground' : 'bg-line-strong'}`}
            />
            <span>
              <b className="mono mr-1 text-[11px] font-medium text-dim">{index + 1}</b>
              {step.label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function Section({
  number,
  title,
  onEdit,
  children,
}: {
  number: number
  title: string
  onEdit?: () => void
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-line pt-3.5">
      <div className="flex items-center gap-2">
        <h3 className="text-[11.5px] font-medium text-muted">
          {number} · {title}
        </h3>
        <span className="flex-1" />
        {onEdit ? (
          <Button variant="ghost" size="sm" onPress={onEdit}>
            Edit
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function Later({ number, title, hint }: { number: number; title: string; hint: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5 text-[12.5px]">
      <span className="mono inline-grid size-5 shrink-0 place-items-center rounded-full border border-line-strong text-[11px] text-muted">
        {number}
      </span>
      <span className="font-medium">{title}</span>
      <span className="truncate text-xs text-muted">{hint}</span>
    </div>
  )
}

function ApplyOutcome({ outcome }: { outcome: MediaApplyResult }) {
  return (
    <div className="flex flex-col gap-2">
      {outcome.mergeRequest ? (
        <Notice tone="success" title={`Merge request !${outcome.mergeRequest.id} opened`}>
          <a
            href={outcome.mergeRequest.url}
            target="_blank"
            rel="noreferrer"
            className="break-all underline"
          >
            {outcome.mergeRequest.url}
          </a>
        </Notice>
      ) : !outcome.applied ? (
        <Notice tone="warning" title="Nothing was applied" />
      ) : null}
      {outcome.conflicts.length ? (
        <Notice tone="warning" title={`${outcome.conflicts.length} file(s) not written`}>
          <ul className="flex flex-col gap-0.5">
            {outcome.conflicts.map((conflict) => (
              <li key={`${conflict.changeId}:${conflict.file}`}>
                <span className="mono">{conflict.file}</span>: {conflict.reason}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  )
}

/**
 * The media optimizer as a side sheet, one step at a time: configure the variants of an image,
 * choose them with their repository paths (suggested paths that already exist at the ref are
 * conflicts), copy markup, then open a merge request or download a ZIP (`analyses:run`). Without a
 * fixed `target.repo` the first step picks one of `repos`. Mount it with a `key` per target so
 * every file starts fresh.
 */
export function MediaSheet({
  target,
  repos = [],
  detail,
  onClose,
  index,
  total,
  onPrevious,
  onNext,
}: {
  target: MediaTarget | undefined
  repos?: readonly RepoRef[]
  /** Facts about the file under the title, e.g. its size and problems. */
  detail?: ReactNode
  onClose: () => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const { can } = useSession()
  const mayApply = can('analyses:run')
  const { variants, apply, zip } = useMediaMutations()
  const [repo, setRepo] = useState(target?.repo ? repoKey(target.repo) : '')
  const [draft, setDraft] = useState<MediaDraft>(() => ({
    ...emptyMediaDraft,
    file: target?.file ?? '',
    ref: target?.ref ?? '',
  }))
  const [submitted, setSubmitted] = useState(false)
  const [step, setStep] = useState<MediaStep>('configure')
  const [result, setResult] = useState<{
    repo: string
    input: MediaDraft
    data: MediaVariantsResult
  }>()
  const [selected, setSelected] = useState<string[]>([])
  const [paths, setPaths] = useState<Record<string, string>>({})
  const [replace, setReplace] = useState(false)
  const [title, setTitle] = useState('')
  const [applied, setApplied] = useState<MediaApplyResult>()

  const errors = submitted ? validateMediaDraft(draft) : {}
  const repoError = submitted && !parseRepoKey(repo) ? 'Pick a repository' : undefined
  const set = <K extends keyof MediaDraft>(key: K, value: MediaDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const generate = () => {
    setSubmitted(true)
    if (Object.keys(validateMediaDraft(draft)).length || !parseRepoKey(repo)) return
    const input = { ...draft }
    variants.mutate(toVariantsInput(repo, input), {
      onSuccess: (data) => {
        setResult({ repo, input, data })
        setSelected(initialSelection(data, input.file))
        setPaths(Object.fromEntries(data.variants.map((variant) => [variant.id, variant.path])))
        setReplace(data.svg !== undefined)
        setApplied(undefined)
        setStep('variants')
      },
    })
  }

  const file = result?.input.file.trim() ?? draft.file.trim()
  const gitRef = result?.input.ref ?? draft.ref
  const offered = result ? offeredVariants(result.data, result.input.file) : []
  const replacement = result ? replacementOf(result.data, result.input.file) : undefined
  const chosen = offered.filter((variant) => selected.includes(variant.id))
  const chosenPaths = chosen.map((variant) => (paths[variant.id] ?? variant.path).trim())
  const duplicates = duplicatePaths(chosenPaths)
  const conflicts = result ? conflictIds(result.data, selected, paths) : []
  const blocker = deliverBlocker({
    chosen: chosen.length,
    replace: replace && replacement !== undefined,
    emptyPaths: chosenPaths.filter((path) => !path).length,
    duplicates: duplicates.size,
    conflicts: conflicts.length,
  })

  const applyInput = () => {
    if (!result) return undefined
    const ref = result.input.ref.trim()
    const swap = replace ? replacement : undefined
    return {
      repo: result.repo,
      file: result.input.file.trim(),
      ...(ref ? { ref } : {}),
      variants: chosen.map((variant) => variant.id),
      paths: Object.fromEntries(
        chosen.map((variant) => [variant.id, (paths[variant.id] ?? variant.path).trim()]),
      ),
      ...(swap ? { replaceOriginal: swap } : {}),
    }
  }

  const openMergeRequest = () => {
    const input = applyInput()
    if (!input) return
    apply.mutate(
      { ...input, mode: 'merge-request', ...(title.trim() ? { title: title.trim() } : {}) },
      {
        onSuccess: (outcome) => {
          setApplied(outcome)
          if (outcome.mergeRequest) notify.success('Merge request opened')
        },
        onError: (error) => notify.error('Merge request not opened', messageOf(error)),
      },
    )
  }

  const downloadZip = () => {
    const input = applyInput()
    if (!input) return
    zip.mutate(
      { ...input, mode: 'zip' },
      {
        onSuccess: (blob) => download(blob, 'media.zip'),
        onError: (error) => notify.error('ZIP not downloaded', messageOf(error)),
      },
    )
  }

  const back = () =>
    setStep(step === 'deliver' ? 'markup' : step === 'markup' ? 'variants' : 'configure')

  const footer =
    step === 'configure' ? (
      <>
        {result ? (
          <Button variant="ghost" onPress={() => setStep('variants')}>
            Keep the variants
          </Button>
        ) : null}
        <Button variant="primary" isPending={variants.isPending} onPress={generate}>
          <ImageDown className="size-4" />
          {result ? 'Generate again' : 'Generate variants'}
        </Button>
      </>
    ) : (
      <>
        <Button variant="secondary" onPress={back}>
          Back
        </Button>
        <span className="flex-1" />
        {blocker && step !== 'markup' ? (
          <span className="text-xs text-muted">{blocker}</span>
        ) : null}
        {step === 'variants' ? (
          <Button variant="primary" isDisabled={Boolean(blocker)} onPress={() => setStep('markup')}>
            Next: Markup
          </Button>
        ) : step === 'markup' ? (
          <Button variant="primary" onPress={() => setStep('deliver')}>
            Next: Deliver
          </Button>
        ) : mayApply ? (
          <>
            <Button
              variant="secondary"
              isPending={zip.isPending}
              isDisabled={Boolean(blocker)}
              onPress={downloadZip}
            >
              Download ZIP
            </Button>
            <Button
              variant="primary"
              isPending={apply.isPending}
              isDisabled={Boolean(blocker)}
              onPress={openMergeRequest}
            >
              Open merge request
            </Button>
          </>
        ) : null}
      </>
    )

  const configuring = step === 'configure'
  const fixedRepo = target?.repo
  const repoOptions = repos.map((ref) => ({ id: repoKey(ref), label: ref.path }))

  return (
    <SideSheet
      open={target !== undefined}
      onClose={onClose}
      id="Media optimizer"
      title={file || 'Optimize an image'}
      {...(index !== undefined ? { index } : {})}
      {...(total !== undefined ? { total } : {})}
      {...(onPrevious ? { onPrevious } : {})}
      {...(onNext ? { onNext } : {})}
      footer={footer}
    >
      <div className="flex flex-col gap-3.5">
        {detail || fixedRepo ? (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
            {fixedRepo ? <span className="mono">{fixedRepo.path}</span> : null}
            {fixedRepo && gitRef.trim() ? (
              <>
                <span>·</span>
                <span className="mono">{gitRef.trim()}</span>
              </>
            ) : null}
            {detail ? (
              <>
                {fixedRepo ? <span>·</span> : null}
                {detail}
              </>
            ) : null}
          </div>
        ) : null}
        <Stepper current={step} />

        <Section
          number={1}
          title={configuring ? 'Configure' : 'Configured'}
          {...(!configuring ? { onEdit: () => setStep('configure') } : {})}
        >
          {configuring ? (
            <div className="flex flex-col gap-3">
              {fixedRepo ? null : (
                <Select
                  label="Repository"
                  options={repoOptions}
                  value={repo || undefined}
                  onChange={setRepo}
                  placeholder="Pick a repository"
                />
              )}
              {repoError ? <span className="text-xs text-bad">{repoError}</span> : null}
              <TextField
                label="Image"
                value={draft.file}
                onChange={(value) => set('file', value)}
                placeholder="public/images/hero.png"
                description="Path in the repository; PNG, JPEG, WebP, GIF or SVG."
                error={errors.file}
                isRequired
                mono
                autoFocus={!draft.file}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') generate()
                }}
              />
              <TextField
                label="Ref"
                value={draft.ref}
                onChange={(value) => set('ref', value)}
                placeholder="default branch"
                description="Branch, tag or commit to read; the merge request targets it."
                mono
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Formats</span>
                <MultiToggle
                  aria-label="Formats"
                  options={mediaFormats.map((format) => ({
                    id: format,
                    label: format.toUpperCase(),
                  }))}
                  value={draft.formats}
                  onChange={(value) => set('formats', value)}
                />
                <span className="text-xs text-muted">
                  None selected: AVIF, WebP and the source format.
                </span>
              </div>
              <TagInput
                label="Widths"
                values={draft.widths}
                onChange={(value) => set('widths', value)}
                placeholder="640, 1280, 1920"
                validate={validateWidth}
                description="Pixels; empty uses a responsive ladder up to the source width."
              />
              <TagInput
                label="Densities"
                values={draft.densities}
                onChange={(value) => set('densities', value)}
                placeholder="1, 2"
                validate={validateDensity}
                description="For fixed-size images and textures: @1x, @2x, ... variants."
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Effort</span>
                <Segmented
                  aria-label="Encoder effort"
                  options={mediaPresets.map((preset) => ({
                    id: preset,
                    label: preset.charAt(0).toUpperCase() + preset.slice(1),
                  }))}
                  value={
                    (mediaPresets as readonly string[]).includes(draft.preset)
                      ? draft.preset
                      : 'default'
                  }
                  onChange={(value) => set('preset', value)}
                />
              </div>
              <TextField
                label="Quality"
                type="number"
                value={draft.quality}
                onChange={(value) => set('quality', value)}
                placeholder="per format"
                description="1–100; empty uses tuned defaults (AVIF 55, WebP and JPEG 78)."
                error={errors.quality}
                min={1}
                max={100}
              />
              {variants.isError ? (
                unavailable(variants.error) ? (
                  <Notice tone="warning" title="Image optimization is not set up">
                    This server has no artifact store or image engine configured.{' '}
                    {messageOf(variants.error)}
                  </Notice>
                ) : (
                  <Notice tone="danger" title="Could not generate variants">
                    {messageOf(variants.error)}
                  </Notice>
                )
              ) : null}
            </div>
          ) : result ? (
            <KeyValue
              rows={configSummary(result.input).map((line) => ({
                label: line.label,
                value: <span className="mono text-xs">{line.value}</span>,
              }))}
            />
          ) : null}
        </Section>

        {result && step === 'variants' ? (
          <Section number={2} title="Choose variants">
            <MediaVariants
              result={result.data}
              file={result.input.file}
              gitRef={gitRef}
              offered={offered}
              selected={selected}
              onSelect={setSelected}
              paths={paths}
              onPath={(id, path) => setPaths((p) => ({ ...p, [id]: path }))}
              duplicates={duplicates}
              conflicts={conflicts}
              replacement={replacement}
              replace={replace}
              onReplace={setReplace}
            />
          </Section>
        ) : result && (step === 'markup' || step === 'deliver') ? (
          <Section number={2} title="Variants chosen" onEdit={() => setStep('variants')}>
            <p className="text-xs text-muted">
              {chosen.length} {chosen.length === 1 ? 'file' : 'files'} added
              {replace && replacement ? ', the original replaced' : ''}
            </p>
          </Section>
        ) : (
          <Later number={2} title="Choose variants" hint="Sizes, savings and repository paths" />
        )}

        {result && step === 'markup' ? (
          <Section number={3} title="Markup">
            <MediaMarkup snippets={result.data.snippets} />
          </Section>
        ) : result && step === 'deliver' ? (
          <Section number={3} title="Markup" onEdit={() => setStep('markup')}>
            <p className="text-xs text-muted">Copy the snippets before you go on, or come back.</p>
          </Section>
        ) : (
          <Later number={3} title="Markup" hint="HTML, React, Vue, Svelte, Astro and more" />
        )}

        {result && step === 'deliver' ? (
          <Section number={4} title="Deliver">
            {mayApply ? (
              <>
                <TextField
                  label="Merge request title"
                  value={title}
                  onChange={setTitle}
                  placeholder={mediaTitle(result.input.file)}
                  description="Optional; the server picks one when empty."
                />
                {applied ? <ApplyOutcome outcome={applied} /> : null}
              </>
            ) : (
              <p className="text-sm text-muted">
                Opening a merge request or downloading the files needs permission to run analyses.
              </p>
            )}
          </Section>
        ) : (
          <Later number={4} title="Deliver" hint="Open a merge request or download a ZIP" />
        )}
      </div>
    </SideSheet>
  )
}
