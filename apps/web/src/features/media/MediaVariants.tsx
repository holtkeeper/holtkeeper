import { type MediaVariantsResult, formatBytes } from '@holtkeeper/api'
import { Check, Copy, Download } from 'lucide-react'
import { useState } from 'react'

import { api } from '../../api/endpoints.ts'
import {
  formatSavings,
  pathError,
  savingsTone,
  selectionText,
  snippetLabel,
} from '../../lib/media.ts'
import { Button, Checkbox, Tabs, Tag, TextField } from '../../ui/index.ts'

function Thumb({ id, label }: { id: string; label: string }) {
  return (
    <a
      href={api.artifactUrl(id)}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${label}`}
      className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-[5px] border border-line bg-raise"
    >
      <img
        src={api.artifactUrl(id)}
        alt=""
        loading="lazy"
        className="max-h-full max-w-full object-contain"
      />
    </a>
  )
}

/**
 * Step 2 of the media optimizer: the offered variants with savings, a checkbox and an editable
 * repository path each, and the choice to replace the original with its optimized file.
 */
export function MediaVariants({
  result,
  file,
  gitRef,
  offered,
  selected,
  onSelect,
  paths,
  onPath,
  duplicates,
  conflicts,
  replacement,
  replace,
  onReplace,
}: {
  result: MediaVariantsResult
  file: string
  gitRef: string
  offered: MediaVariantsResult['variants']
  selected: readonly string[]
  onSelect: (ids: string[]) => void
  paths: Readonly<Record<string, string>>
  onPath: (id: string, path: string) => void
  duplicates: ReadonlySet<string>
  conflicts: readonly string[]
  replacement: string | undefined
  replace: boolean
  onReplace: (value: boolean) => void
}) {
  const { original, savings, svg } = result
  const allSelected = offered.length > 0 && offered.every((v) => selected.includes(v.id))
  const toggle = (id: string, on: boolean) =>
    onSelect(on ? [...selected, id] : selected.filter((other) => other !== id))
  const conflictNames = offered
    .filter((variant) => conflicts.includes(variant.id))
    .map((variant) => variant.path.split('/').at(-1) ?? variant.path)

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
        <span>
          Original {original.format.toUpperCase()}
          {original.width ? ` ${original.width}×${original.height}` : ''},{' '}
          <span className="mono">{formatBytes(original.bytes)}</span>
        </span>
        {savings.bestFormat ? (
          <Tag tone="success">
            best {savings.bestFormat.toUpperCase()} saves {Math.round(savings.bestSavingsPercent)}%
          </Tag>
        ) : null}
        {offered.length ? <span>· {selectionText(offered, selected)}</span> : null}
        {offered.length ? (
          <Button
            variant="ghost"
            size="sm"
            className="ms-auto"
            onPress={() => onSelect(allSelected ? [] : offered.map((v) => v.id))}
          >
            {allSelected ? 'Select none' : 'Select all'}
          </Button>
        ) : null}
      </div>
      {offered.length ? (
        <div className="overflow-x-auto rounded-[10px] border border-line bg-sunk">
          <table className="w-full border-collapse text-xs" aria-label="Variants">
            <thead>
              <tr className="text-left text-[11px] text-muted">
                <th className="px-2 py-[7px] font-medium">
                  <span className="sr-only">Use</span>
                </th>
                <th className="px-2 py-[7px] font-medium">Variant</th>
                <th className="px-2 py-[7px] text-right font-medium">Size</th>
                <th className="px-2 py-[7px] text-right font-medium">Saving</th>
                <th className="px-2 py-[7px] font-medium">Path in repository</th>
                <th className="px-2 py-[7px] font-medium">
                  <span className="sr-only">File</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {offered.map((variant) => {
                const label = `${variant.format.toUpperCase()} ${variant.width}×${variant.height}`
                const path = paths[variant.id] ?? variant.path
                const on = selected.includes(variant.id)
                const error = on
                  ? pathError(path, {
                      duplicate: duplicates.has(path.trim()),
                      exists: conflicts.includes(variant.id),
                      ref: gitRef,
                    })
                  : undefined
                return (
                  <tr
                    key={variant.id}
                    className={`border-t border-line align-middle ${on ? '' : 'text-dim'}`}
                  >
                    <td className="px-2 py-[7px]">
                      <Checkbox
                        label={<span className="sr-only">Use {label}</span>}
                        isSelected={on}
                        onChange={(value) => toggle(variant.id, value)}
                      />
                    </td>
                    <td className="px-2 py-[7px]">
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        <Thumb id={variant.id} label={label} />
                        <span>
                          <span className="font-medium">{variant.format.toUpperCase()}</span>{' '}
                          <span className="mono text-muted">
                            {variant.width}×{variant.height} · q{variant.quality}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="mono px-2 py-[7px] text-right whitespace-nowrap">
                      {formatBytes(variant.bytes)}
                    </td>
                    <td className="px-2 py-[7px] text-right">
                      <Tag tone={savingsTone(variant.savingsPercent)}>
                        {formatSavings(variant.savingsPercent)}
                      </Tag>
                    </td>
                    <td className="min-w-40 px-2 py-[7px]">
                      <TextField
                        aria-label={`Path of ${label}`}
                        value={path}
                        onChange={(value) => onPath(variant.id, value)}
                        error={error}
                        isDisabled={!on}
                        mono
                      />
                    </td>
                    <td className="px-2 py-[7px]">
                      <a
                        href={api.artifactUrl(variant.id)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Download ${label}`}
                        className="grid size-7 place-items-center rounded-md text-muted hover:text-foreground"
                      >
                        <Download className="size-3.5" />
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted">
          {svg
            ? 'The optimized SVG is the only file.'
            : 'The engine found nothing smaller to make.'}
        </p>
      )}
      {conflictNames.length ? (
        <div className="flex items-start gap-2 rounded-[9px] border border-[color-mix(in_oklab,var(--warn)_30%,transparent)] bg-[color-mix(in_oklab,var(--warn)_8%,transparent)] px-[11px] py-[9px] text-xs">
          <span>
            <b>{conflictNames.length === 1 ? 'Conflict:' : 'Conflicts:'}</b>{' '}
            <span className="mono">{conflictNames.join(', ')}</span> already{' '}
            {conflictNames.length === 1 ? 'exists' : 'exist'} on{' '}
            <span className="mono">{gitRef.trim() || 'the default branch'}</span>. Change the path
            or leave the variant out.
          </span>
        </div>
      ) : null}
      {svg ? (
        <p className="text-xs text-muted">
          Optimized SVG <span className="mono">{formatBytes(svg.before)}</span> →{' '}
          <span className="mono">{formatBytes(svg.after)}</span>
          {Object.entries(svg.breakdown)
            .filter(([, bytes]) => bytes !== 0)
            .toSorted(([, a], [, b]) => b - a)
            .slice(0, 4)
            .map(([step, bytes]) => ` · ${step} ${formatBytes(bytes)}`)
            .join('')}
        </p>
      ) : null}
      {replacement ? (
        <Checkbox
          label={
            <>
              Replace <span className="mono">{file}</span> with the{' '}
              {svg ? 'optimized' : 're-encoded'} file
            </>
          }
          isSelected={replace}
          onChange={onReplace}
        />
      ) : null}
    </div>
  )
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="relative">
      <pre className="mono max-h-80 overflow-auto rounded-[10px] border border-line bg-sunk px-3 py-2 pr-12 text-xs">
        {code}
      </pre>
      <span className="absolute top-1.5 right-1.5">
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label={copied ? 'Copied' : `Copy ${label}`}
          onPress={() => void copy()}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </span>
    </div>
  )
}

/** Step 3 of the media optimizer: markup per framework that uses the variants. */
export function MediaMarkup({ snippets }: { snippets: Readonly<Record<string, string>> }) {
  const entries = Object.entries(snippets)
  if (!entries.length) return <p className="text-sm text-muted">No markup for these files.</p>
  return (
    <Tabs
      aria-label="Snippets"
      items={entries.map(([framework, code]) => ({
        id: framework,
        label: snippetLabel(framework),
        content: <CodeBlock code={code} label={`${snippetLabel(framework)} snippet`} />,
      }))}
    />
  )
}
