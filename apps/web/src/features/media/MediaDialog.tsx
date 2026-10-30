import type { MediaApplyResult, MediaVariantsResult, RepoRef } from '@holtkeeper/api'
import { ImageDown } from 'lucide-react'
import { useState } from 'react'

import { ApiError, messageOf } from '../../api/client.ts'
import { useMediaMutations } from '../../api/queries.ts'
import {
  type MediaDraft,
  duplicatePaths,
  emptyMediaDraft,
  mediaFormats,
  mediaPresets,
  toVariantsInput,
  validateDensity,
  validateMediaDraft,
  validateWidth,
} from '../../lib/media.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  Dialog,
  MultiToggle,
  Notice,
  Segmented,
  TagInput,
  TextField,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { MediaResult } from './MediaResult.tsx'

const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Generates responsive variants of a repository image and opens a merge request or a ZIP with them. */
function MediaDialog({
  repo,
  isOpen,
  onOpenChange,
  initial,
}: {
  repo: RepoRef
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  initial?: { file?: string; ref?: string }
}) {
  const { can } = useSession()
  const mayApply = can('analyses:run')
  const { variants, apply, zip } = useMediaMutations()
  const [draft, setDraft] = useState<MediaDraft>(() => ({
    ...emptyMediaDraft,
    file: initial?.file ?? '',
    ref: initial?.ref ?? '',
  }))
  const [submitted, setSubmitted] = useState(false)
  const [result, setResult] = useState<{ input: MediaDraft; data: MediaVariantsResult }>()
  const [selected, setSelected] = useState<string[]>([])
  const [paths, setPaths] = useState<Record<string, string>>({})
  const [replaceOriginal, setReplaceOriginal] = useState(false)
  const [title, setTitle] = useState('')
  const [applied, setApplied] = useState<MediaApplyResult>()
  const errors = submitted ? validateMediaDraft(draft) : {}
  const set = <K extends keyof MediaDraft>(key: K, value: MediaDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const key = repoKey(repo)

  const generate = () => {
    setSubmitted(true)
    if (Object.keys(validateMediaDraft(draft)).length) return
    const input = { ...draft }
    variants.mutate(toVariantsInput(key, input), {
      onSuccess: (data) => {
        setResult({ input, data })
        setSelected(data.variants.map((variant) => variant.id))
        setPaths(Object.fromEntries(data.variants.map((variant) => [variant.id, variant.path])))
        setReplaceOriginal(data.svg !== undefined)
        setApplied(undefined)
      },
    })
  }

  const applyInput = () => {
    if (!result) return undefined
    const ref = result.input.ref.trim()
    const chosen = result.data.variants.filter((variant) => selected.includes(variant.id))
    const svg = replaceOriginal ? result.data.svg?.id : undefined
    return {
      repo: key,
      file: result.input.file.trim(),
      ...(ref ? { ref } : {}),
      variants: chosen.map((variant) => variant.id),
      paths: Object.fromEntries(
        chosen.map((variant) => [variant.id, (paths[variant.id] ?? variant.path).trim()]),
      ),
      ...(svg ? { replaceOriginal: svg } : {}),
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

  const chosenPaths = (result?.data.variants ?? [])
    .filter((variant) => selected.includes(variant.id))
    .map((variant) => (paths[variant.id] ?? variant.path).trim())
  const duplicates = duplicatePaths(chosenPaths)
  const cannotApply =
    (!selected.length && !replaceOriginal) || duplicates.size > 0 || chosenPaths.some((p) => !p)

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="xl"
      title="Optimize an image"
      description={
        <>
          Responsive AVIF, WebP and re-encoded variants of an image in{' '}
          <span className="font-mono">{repo.path}</span>, with markup to use them.
        </>
      }
      footer={
        <>
          <Button variant="tertiary" onPress={() => onOpenChange(false)}>
            Close
          </Button>
          {result && mayApply ? (
            <>
              <Button
                variant="secondary"
                isPending={zip.isPending}
                isDisabled={cannotApply}
                onPress={downloadZip}
              >
                Download ZIP
              </Button>
              <Button
                variant="primary"
                isPending={apply.isPending}
                isDisabled={cannotApply}
                onPress={openMergeRequest}
              >
                Open merge request
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <TextField
          label="Image"
          value={draft.file}
          onChange={(value) => set('file', value)}
          placeholder="public/images/hero.png"
          description="Path in the repository; PNG, JPEG, WebP, GIF or SVG."
          error={errors.file}
          isRequired
          mono
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Enter') generate()
          }}
        />
        <TextField
          label="Ref"
          value={draft.ref}
          onChange={(value) => set('ref', value)}
          placeholder="default branch"
          description="Branch, tag or commit to read; merge requests target it."
          mono
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Formats</span>
          <MultiToggle
            aria-label="Formats"
            options={mediaFormats.map((format) => ({ id: format, label: format.toUpperCase() }))}
            value={draft.formats}
            onChange={(value) => set('formats', value)}
          />
          <span className="text-xs text-muted">
            None selected: AVIF, WebP and the source format.
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Effort</span>
          <Segmented
            aria-label="Encoder effort"
            options={mediaPresets.map((preset) => ({
              id: preset,
              label: preset.charAt(0).toUpperCase() + preset.slice(1),
            }))}
            value={
              (mediaPresets as readonly string[]).includes(draft.preset) ? draft.preset : 'default'
            }
            onChange={(value) => set('preset', value)}
          />
          <span className="text-xs text-muted">Higher effort encodes slower and smaller.</span>
        </div>
        <TagInput
          label="Widths"
          values={draft.widths}
          onChange={(value) => set('widths', value)}
          placeholder="320, 640, 1280"
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
        <div className="flex items-end justify-end">
          <Button
            variant={result ? 'secondary' : 'primary'}
            isPending={variants.isPending}
            onPress={generate}
          >
            <ImageDown className="size-4" />
            {result ? 'Generate again' : 'Generate'}
          </Button>
        </div>
      </div>

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

      {result ? (
        <MediaResult
          result={result.data}
          file={result.input.file}
          selected={selected}
          onSelect={setSelected}
          paths={paths}
          duplicates={duplicates}
          onPath={(id, path) => setPaths((p) => ({ ...p, [id]: path }))}
          replaceOriginal={replaceOriginal}
          onReplaceOriginal={setReplaceOriginal}
        />
      ) : null}

      {result && mayApply ? (
        <TextField
          label="Merge request title"
          value={title}
          onChange={setTitle}
          placeholder={`Optimize ${result.input.file.split('/').at(-1) ?? 'image'}`}
          description="Optional; the server picks one when empty."
        />
      ) : null}

      {applied ? <ApplyOutcome outcome={applied} /> : null}
    </Dialog>
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
                <span className="font-mono">{conflict.file}</span>: {conflict.reason}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  )
}

/** Opens the media dialog for a repository; hidden without `analyses:run`. */
export function MediaButton({ repo }: { repo: RepoRef }) {
  const { can } = useSession()
  const [open, setOpen] = useState(false)
  if (!can('analyses:run')) return null
  return (
    <>
      <Button variant="secondary" onPress={() => setOpen(true)}>
        <ImageDown className="size-4" />
        Optimize image
      </Button>
      {open ? <MediaDialog repo={repo} isOpen onOpenChange={setOpen} /> : null}
    </>
  )
}
