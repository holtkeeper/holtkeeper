import type { HandbookEntry, HandbookLink } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, ExternalLink } from 'lucide-react'

import { formatRelative } from '../../lib/format.ts'
import {
  entryAnchor,
  freshnessLine,
  linkKindLabel,
  needsAttention,
  relatedTo,
} from '../../lib/handbook.ts'
import { kbId, kindLabel } from '../../lib/knowledge.ts'
import { parseRepoKey, repoSplat } from '../../lib/repo.ts'
import { type TeamTitleOf } from '../../lib/team-titles.ts'
import { Button, Markdown, Tag } from '../../ui/index.ts'

/**
 * One entry of the handbook article: title, kind, text, where it applies, how fresh it is,
 * evidence and the entries it is linked to. Clicking a related entry or the proposal calls back;
 * the article scrolls and the Notes sheet opens there.
 */
export function HandbookEntrySection({
  entry,
  links,
  titles,
  titleOf,
  selected,
  onSelect,
  onOpenNote,
}: {
  entry: HandbookEntry
  links: readonly HandbookLink[]
  /** Titles of every entry shown, by id. */
  titles: ReadonlyMap<string, string>
  titleOf: TeamTitleOf
  selected: boolean
  onSelect: (id: string) => void
  onOpenNote: (id: string) => void
}) {
  const related = relatedTo(links, entry.id).filter((r) => titles.has(r.id))
  const { freshness } = entry
  const line = freshness ? freshnessLine(freshness) : undefined
  return (
    <section
      id={entryAnchor(entry.id)}
      aria-labelledby={`${entryAnchor(entry.id)}-title`}
      className={`scroll-mt-4 rounded-lg border p-4 ${
        selected ? 'border-accent bg-sunk' : 'border-line'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${entryAnchor(entry.id)}-title`} className="text-base font-semibold">
          {entry.title}
        </h3>
        <Tag>{kindLabel(entry.kind)}</Tag>
        <Tag mono title={`Version ${entry.version}`}>
          {kbId(entry.id, true)}
        </Tag>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onPress={() => onOpenNote(entry.id)}>
          Open note
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <Tag tone="info">{entry.scope}</Tag>
        {entry.repos.map((key) => {
          const repo = parseRepoKey(key)
          return repo ? (
            <Link key={key} to="/repos/$" params={{ _splat: repoSplat(repo) }}>
              <Tag mono className="hover:underline">
                {repo.path}
              </Tag>
            </Link>
          ) : (
            <Tag key={key} mono>
              {key}
            </Tag>
          )
        })}
        {entry.owner.map((team) => (
          <Tag key={team} tone="accent">
            {titleOf(team)}
          </Tag>
        ))}
        {entry.topics.map((topic) => (
          <Tag key={topic} mono>
            {topic}
          </Tag>
        ))}
        <span className="text-dim">updated {formatRelative(entry.updatedAt)}</span>
      </div>
      <Markdown text={entry.body} className="mt-3" />
      {freshness && line ? (
        needsAttention(entry) ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
            <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0 flex-1">
              {line.text}
              {freshness.signals.length ? (
                <span className="block text-xs text-muted">{freshness.signals.join(' · ')}</span>
              ) : null}
            </span>
            {freshness.proposal ? (
              <Button
                variant="secondary"
                size="sm"
                onPress={() => onOpenNote(freshness.proposal ?? entry.id)}
              >
                Review proposed replacement
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-xs text-dim">{line.text}</p>
        )
      ) : null}
      {entry.evidence.length ? (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {entry.evidence.map((link) => (
            <li key={link.url}>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-muted hover:text-foreground hover:underline"
              >
                <ExternalLink className="size-3" aria-hidden />
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {related.length ? (
        <div className="mt-3 border-t border-line pt-2 text-xs">
          <span className="font-medium text-muted">Related</span>
          <ul className="mt-1 flex flex-col gap-0.5">
            {related.map((r) => (
              <li key={`${r.id}-${r.kind}-${r.outgoing}`} className="flex gap-2">
                <span className="w-28 shrink-0 text-dim">{linkKindLabel(r.kind, r.outgoing)}</span>
                <button
                  type="button"
                  className="min-w-0 truncate text-left hover:underline"
                  onClick={() => onSelect(r.id)}
                >
                  {titles.get(r.id)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
