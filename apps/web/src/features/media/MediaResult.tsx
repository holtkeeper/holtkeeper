import { type MediaVariantsResult, formatBytes } from '@holtkeeper/api'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { api } from '../../api/endpoints.ts'
import { formatSavings, savingsTone, snippetLabel } from '../../lib/media.ts'
import {
  Button,
  Checkbox,
  Chip,
  EmptyState,
  Panel,
  Table,
  Tabs,
  Td,
  TextField,
  Th,
} from '../../ui/index.ts'

function Savings({ percent }: { percent: number }) {
  return (
    <Chip tone={savingsTone(percent)} size="sm">
      {formatSavings(percent)}
    </Chip>
  )
}

function Preview({ id, label }: { id: string; label: string }) {
  return (
    <a
      href={api.artifactUrl(id)}
      target="_blank"
      rel="noreferrer"
      className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-default"
      aria-label={`Open ${label}`}
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

function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="relative">
      <pre className="max-h-80 overflow-auto rounded-xl border border-border bg-default px-3 py-2 pr-12 font-mono text-xs">
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

/** Generated variants of one image: savings, selectable files with editable paths, and snippets. */
export function MediaResult({
  result,
  file,
  selected,
  onSelect,
  paths,
  duplicates,
  onPath,
  replaceOriginal,
  onReplaceOriginal,
}: {
  result: MediaVariantsResult
  file: string
  selected: readonly string[]
  onSelect: (ids: string[]) => void
  paths: Readonly<Record<string, string>>
  duplicates: ReadonlySet<string>
  onPath: (id: string, path: string) => void
  replaceOriginal: boolean
  onReplaceOriginal: (value: boolean) => void
}) {
  const { original, savings, svg } = result
  const snippets = Object.entries(result.snippets)
  const allSelected = result.variants.length > 0 && selected.length === result.variants.length
  const toggle = (id: string, on: boolean) =>
    onSelect(on ? [...selected, id] : selected.filter((other) => other !== id))

  return (
    <div className="flex flex-col gap-4">
      <Panel
        variant="secondary"
        title="Savings"
        description={
          <>
            Original {original.format.toUpperCase()}
            {original.width ? ` ${original.width}×${original.height}` : ''},{' '}
            {formatBytes(original.bytes)}
            {savings.bestFormat ? (
              <>
                {' '}
                · best {savings.bestFormat.toUpperCase()} saves{' '}
                {Math.round(savings.bestSavingsPercent)}%
              </>
            ) : null}
          </>
        }
      >
        <Table label="Savings by format">
          <thead>
            <tr>
              <Th>Format</Th>
              <Th align="right">Width</Th>
              <Th align="right">Size</Th>
              <Th align="right">Saving</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td className="text-muted">original {original.format}</Td>
              <Td align="right" className="tabular-nums text-muted">
                {original.width || '—'}
              </Td>
              <Td align="right" className="tabular-nums text-muted">
                {formatBytes(original.bytes)}
              </Td>
              <Td />
            </tr>
            {savings.formats.map((row) => (
              <tr key={`${row.format}:${row.width}`}>
                <Td className={row.format === savings.bestFormat ? 'font-medium' : undefined}>
                  {row.format.toUpperCase()}
                </Td>
                <Td align="right" className="tabular-nums">
                  {row.width || '—'}
                </Td>
                <Td align="right" className="tabular-nums">
                  {formatBytes(row.bytes)}
                </Td>
                <Td align="right">
                  <Savings percent={row.savingsPercent} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>

      {svg ? (
        <Panel
          variant="secondary"
          title="Optimized SVG"
          description={`${formatBytes(svg.before)} → ${formatBytes(svg.after)}`}
        >
          <div className="flex flex-wrap items-start gap-4">
            <Preview id={svg.id} label="optimized SVG" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {Object.keys(svg.breakdown).length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {Object.entries(svg.breakdown)
                    .filter(([, bytes]) => bytes !== 0)
                    .toSorted(([, a], [, b]) => b - a)
                    .map(([step, bytes]) => (
                      <li key={step}>
                        <Chip size="sm">
                          {step} <span className="text-muted">{formatBytes(bytes)}</span>
                        </Chip>
                      </li>
                    ))}
                </ul>
              ) : null}
              <Checkbox
                label={
                  <>
                    Replace <span className="font-mono">{file}</span> with the optimized file
                  </>
                }
                isSelected={replaceOriginal}
                onChange={onReplaceOriginal}
              />
            </div>
          </div>
        </Panel>
      ) : null}

      {result.variants.length ? (
        <Panel
          variant="secondary"
          title="Variants"
          description="Chosen files are added at these paths; existing files are reported as conflicts."
          actions={
            <Button
              variant="ghost"
              size="sm"
              onPress={() => onSelect(allSelected ? [] : result.variants.map((v) => v.id))}
            >
              {allSelected ? 'Select none' : 'Select all'}
            </Button>
          }
        >
          <Table label="Variants">
            <thead>
              <tr>
                <Th />
                <Th>Preview</Th>
                <Th>Variant</Th>
                <Th align="right">Size</Th>
                <Th align="right">Saving</Th>
                <Th className="w-1/2">Path</Th>
              </tr>
            </thead>
            <tbody>
              {result.variants.map((variant) => {
                const label = `${variant.format} ${variant.width}w`
                const path = paths[variant.id] ?? variant.path
                const isSelected = selected.includes(variant.id)
                const error = !isSelected
                  ? undefined
                  : !path.trim()
                    ? 'Enter a path'
                    : duplicates.has(path.trim())
                      ? 'Another variant uses this path'
                      : undefined
                return (
                  <tr key={variant.id}>
                    <Td>
                      <Checkbox
                        label={<span className="sr-only">Include {label}</span>}
                        isSelected={isSelected}
                        onChange={(on) => toggle(variant.id, on)}
                      />
                    </Td>
                    <Td>
                      <Preview id={variant.id} label={label} />
                    </Td>
                    <Td>
                      <div className="font-medium">{variant.format.toUpperCase()}</div>
                      <div className="text-xs tabular-nums text-muted">
                        {variant.width}×{variant.height} · q{variant.quality}
                      </div>
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {formatBytes(variant.bytes)}
                    </Td>
                    <Td align="right">
                      <Savings percent={variant.savingsPercent} />
                    </Td>
                    <Td>
                      <div className="flex items-start gap-1">
                        <TextField
                          aria-label={`Path of ${label}`}
                          value={path}
                          onChange={(value) => onPath(variant.id, value)}
                          error={error}
                          isDisabled={!isSelected}
                          mono
                          className="min-w-48 flex-1"
                        />
                        <a
                          href={api.artifactUrl(variant.id)}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Download ${label}`}
                          className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:text-foreground"
                        >
                          <ExternalLink className="size-3.5" />
                        </a>
                      </div>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        </Panel>
      ) : !svg ? (
        <EmptyState
          title="No variants"
          description="The engine found nothing smaller to produce."
        />
      ) : null}

      {snippets.length ? (
        <Panel variant="secondary" title="Markup" description="Use the variants in your templates.">
          <Tabs
            aria-label="Snippets"
            items={snippets.map(([framework, code]) => ({
              id: framework,
              label: snippetLabel(framework),
              content: <CodeBlock code={code} label={`${snippetLabel(framework)} snippet`} />,
            }))}
          />
        </Panel>
      ) : null}
    </div>
  )
}
