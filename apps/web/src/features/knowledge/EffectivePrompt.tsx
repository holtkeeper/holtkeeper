import type { EffectiveRules, RepoRef, RuleAgent } from '@holtkeeper/api'
import { X } from 'lucide-react'
import { useState } from 'react'

import { useEffectiveRules } from '../../api/queries.ts'
import { formatCount as number } from '../../lib/format.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { blockSubtitle, parseFiles, ruleAgents, tokensOf } from '../../lib/rules.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import {
  Button,
  CopyButton,
  ErrorState,
  Notice,
  Placeholder,
  SegmentBar,
  Segmented,
  Select,
  Tag,
  TextField,
  UnderlineTabs,
} from '../../ui/index.ts'

/** `1,200` for a whole block, `800 / 1,200` for a cut one. */
const charsOf = (block: { chars: number; fullChars: number }) =>
  `${number(block.chars)}${block.chars === block.fullChars ? '' : ` / ${number(block.fullChars)}`}`

function BudgetBar({ budget }: { budget: EffectiveRules['budget'] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="mono text-[13px] font-semibold">{number(budget.used)}</span>
        <span className="mono text-muted">of {number(budget.total)} characters</span>
        <span className="mono text-dim">≈ {number(tokensOf(budget.used))} tokens</span>
      </div>
      <SegmentBar
        segments={[{ value: budget.used, tone: 'accent', label: 'characters used' }]}
        total={budget.total}
      />
      <p className="text-xs text-dim">
        Rules files share at most <span className="mono">{number(budget.repoFiles)}</span>, learned
        rules at most <span className="mono">{number(budget.learnings)}</span>.
      </p>
    </div>
  )
}

function Blocks({ rules }: { rules: EffectiveRules }) {
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
        {rules.blocks.map((block) => (
          <li
            key={`${block.layer}:${block.id}`}
            className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium" title={block.title}>
                {block.title}
              </span>
              <span className="truncate text-xs text-muted">{blockSubtitle(block)}</span>
            </span>
            {block.chars === 0 ? (
              <Tag tone="danger">left out</Tag>
            ) : block.cut ? (
              <Tag tone="warning">cut</Tag>
            ) : null}
            <span className="mono text-xs text-muted">{charsOf(block)}</span>
          </li>
        ))}
        {rules.blocks.length === 0 ? (
          <li className="px-3 py-2 text-sm text-muted">Nothing applies to this run.</li>
        ) : null}
      </ul>
      {rules.requested.length ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-[11.5px] font-medium text-muted">On request</h3>
          <ul className="flex flex-col gap-1 text-[12.5px]">
            {rules.requested.map((rule) => (
              <li key={rule.id}>
                <span className="font-medium">{rule.title}</span>
                <span className="text-muted">
                  {' '}
                  · {rule.source} · {rule.description}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

const FullText = ({ text }: { text: string }) =>
  text ? (
    <pre className="mono max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-raise p-3 text-xs">
      {text}
    </pre>
  ) : (
    <p className="text-sm text-muted">Nothing applies to this run.</p>
  )

function Warnings({ warnings }: { warnings: readonly string[] }) {
  if (!warnings.length) return <p className="text-sm text-muted">No warnings.</p>
  return (
    <Notice tone="warning" title="Warnings">
      <ul className="list-disc pl-4">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </Notice>
  )
}

/**
 * The effective prompt: exactly the rules block one run on a repository gets (Review, Agent task,
 * Chat or Release notes), optionally for some touched files, with the 12k budget, every block in
 * prompt order with its size and whether it was cut, the rules offered on request, warnings and
 * the full text. With `repos` the repository is picked from them; with `repo` alone it is fixed.
 */
export function EffectivePromptPanel({
  repos,
  repo: fixed,
  onClose,
}: {
  /** Repositories to choose from, `forge:path`; the first one is picked unless `repo` is set. */
  repos?: readonly string[]
  repo?: RepoRef
  onClose?: () => void
}) {
  const [picked, setPicked] = useState<RepoRef | undefined>(
    fixed ?? parseRepoKey(repos?.[0] ?? undefined),
  )
  const [agent, setAgent] = useState<RuleAgent>('review')
  const [filesText, setFilesText] = useState('')
  const [view, setView] = useState<'blocks' | 'text' | 'warnings'>('blocks')
  const files = parseFiles(useDebounced(filesText, 400))
  const repo = repos ? picked : fixed
  const rules = useEffectiveRules(repo, agent, files)

  return (
    <section
      aria-label="Effective prompt"
      className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">Effective prompt</h2>
          <p className="text-xs text-muted">
            Exactly what one run on the repository gets, block by block, from saved rules.
          </p>
        </div>
        {onClose ? (
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="Close effective prompt"
            onPress={onClose}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </header>
      <div className="flex flex-wrap items-end gap-3">
        {repos ? (
          <Select
            label="Repository"
            options={repos.map((key) => ({ id: key, label: key }))}
            value={picked ? repoKey(picked) : undefined}
            onChange={(key) => setPicked(parseRepoKey(key))}
            placeholder="Choose a repository"
            className="min-w-56"
          />
        ) : null}
        <Segmented aria-label="Run" options={ruleAgents} value={agent} onChange={setAgent} />
        <TextField
          label="Touched files"
          value={filesText}
          onChange={setFilesText}
          placeholder="e.g. src/routes/cart.ts, src/cart/total.ts"
          mono
          className="min-w-64 flex-1"
        />
      </div>
      {!repo ? (
        <p className="text-sm text-muted">Choose a repository to see what its runs get.</p>
      ) : rules.isPending ? (
        <Placeholder className="h-48" />
      ) : rules.isError ? (
        <ErrorState error={rules.error} />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <BudgetBar budget={rules.data.budget} />
            </div>
            <CopyButton text={() => rules.data.text} isDisabled={!rules.data.text}>
              Copy text
            </CopyButton>
          </div>
          <UnderlineTabs
            aria-label="Effective prompt views"
            items={[
              { id: 'blocks', label: 'Blocks', badge: rules.data.blocks.length },
              { id: 'text', label: 'Full text' },
              { id: 'warnings', label: 'Warnings', badge: rules.data.warnings.length },
            ]}
            selected={view}
            onSelect={(id) => setView(id === 'text' || id === 'warnings' ? id : 'blocks')}
          />
          {view === 'blocks' ? <Blocks rules={rules.data} /> : null}
          {view === 'text' ? <FullText text={rules.data.text} /> : null}
          {view === 'warnings' ? <Warnings warnings={rules.data.warnings} /> : null}
        </>
      )}
    </section>
  )
}
