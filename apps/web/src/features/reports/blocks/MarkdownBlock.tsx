import type { Block } from '@holtkeeper/api'
import { useMemo } from 'react'

import { type Inline, parseMarkdown } from '../../../lib/markdown.ts'

function Inlines({ items }: { items: readonly Inline[] }) {
  return items.map((item, index) => {
    switch (item.kind) {
      case 'text':
        return <span key={index}>{item.text}</span>
      case 'code':
        return (
          <code key={index} className="rounded bg-default px-1 py-0.5 font-mono text-[0.9em]">
            {item.text}
          </code>
        )
      case 'strong':
        return (
          <strong key={index}>
            <Inlines items={item.children} />
          </strong>
        )
      case 'em':
        return (
          <em key={index}>
            <Inlines items={item.children} />
          </em>
        )
      default:
        return (
          <a
            key={index}
            href={item.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            <Inlines items={item.children} />
          </a>
        )
    }
  })
}

const headingClass = [
  '',
  'text-lg font-semibold',
  'text-base font-semibold',
  'text-sm font-semibold',
  'text-sm font-medium',
]

/** A safe markdown subset; raw HTML is shown as text, links only to http(s) and mailto. */
export function MarkdownBlock({ block }: { block: Extract<Block, { type: 'markdown' }> }) {
  const blocks = useMemo(() => parseMarkdown(block.text), [block.text])
  return (
    <div className="flex max-w-3xl flex-col gap-3 text-sm leading-relaxed">
      {blocks.map((item, index) => {
        switch (item.kind) {
          case 'heading':
            return (
              <p
                key={index}
                role="heading"
                aria-level={item.level + 2}
                className={headingClass[item.level]}
              >
                <Inlines items={item.children} />
              </p>
            )
          case 'paragraph':
            return (
              <p key={index}>
                <Inlines items={item.children} />
              </p>
            )
          case 'list': {
            const List = item.ordered ? 'ol' : 'ul'
            return (
              <List
                key={index}
                className={`flex flex-col gap-1 pl-5 ${item.ordered ? 'list-decimal' : 'list-disc'}`}
              >
                {item.items.map((entry, i) => (
                  <li key={i}>
                    <Inlines items={entry} />
                  </li>
                ))}
              </List>
            )
          }
          case 'code':
            return (
              <pre
                key={index}
                className="overflow-x-auto rounded-xl bg-default p-3 font-mono text-xs"
              >
                {item.text}
              </pre>
            )
          case 'quote':
            return (
              <blockquote key={index} className="border-l-2 border-border-tertiary pl-3 text-muted">
                <Inlines items={item.children} />
              </blockquote>
            )
          default:
            return <hr key={index} className="border-separator" />
        }
      })}
    </div>
  )
}
