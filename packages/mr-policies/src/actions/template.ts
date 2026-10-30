import type { MergeRequestEvent } from '../model.ts'

/**
 * Replaces `{author}`, `{sourceBranch}`, `{targetBranch}`, `{title}`, `{id}`, `{repo}` and `{actor}`
 * with values from the event; unknown placeholders stay as they are.
 */
export function renderTemplate(template: string, event: MergeRequestEvent): string {
  const values: Record<string, string> = {
    author: event.mr.author,
    sourceBranch: event.mr.sourceBranch,
    targetBranch: event.mr.targetBranch,
    title: event.mr.title,
    id: String(event.mr.id),
    repo: event.repo.path,
    actor: event.actor,
  }
  return template.replaceAll(
    /\{(\w+)\}/g,
    (placeholder, name: string) => values[name] ?? placeholder,
  )
}
