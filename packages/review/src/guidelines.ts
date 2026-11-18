import { join } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'
import { ROOT_RULE_FILES, type RepoRuleFile, readRepoRules } from '@holtkeeper/rules'

async function checkoutPaths(
  runner: CommandRunner,
  dir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const listed = await runner
    .run(['git', 'ls-files'], { cwd: dir, ...(signal && { signal }) })
    .catch(() => undefined)
  const tracked = listed?.exitCode === 0 ? listed.stdout.split('\n').filter(Boolean) : []
  const present = await Promise.all(
    ROOT_RULE_FILES.map(async (path) => ((await Bun.file(join(dir, path)).exists()) ? path : '')),
  )
  return [...new Set([...tracked, ...present.filter(Boolean)])]
}

/**
 * The rules files of a checkout (`readRepoRules`): those among the files `git ls-files` lists,
 * plus the root rules files present on disk (all a checkout git cannot list has).
 */
export async function readCheckoutRules(
  runner: CommandRunner,
  dir: string,
  signal?: AbortSignal,
): Promise<RepoRuleFile[]> {
  const paths = await checkoutPaths(runner, dir, signal)
  return readRepoRules({
    paths,
    read: async (path) => {
      const file = Bun.file(join(dir, path))
      return (await file.exists()) ? file.text() : undefined
    },
  })
}

/** Review rules for files matching `glob`, from REVIEW.md. */
export interface PathInstruction {
  glob: string
  text: string
}

/**
 * Rules listed under a `## Paths` (or `## Path instructions`) heading of REVIEW.md, one per bullet
 * as `` - `glob`: rule ``; indented lines below a bullet continue its rule.
 */
export function pathInstructionsInReviewMd(text: string): PathInstruction[] {
  const rules: PathInstruction[] = []
  let inSection = false
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim())
    if (heading) {
      inSection = /^paths?\b/i.test(heading[1] ?? '')
      continue
    }
    if (!inSection) continue
    const bullet = /^[-*]\s+`?([^`\s:]+)`?\s*:\s*(.*)$/.exec(line)
    const last = rules.at(-1)
    if (bullet?.[1]) rules.push({ glob: bullet[1], text: bullet[2]?.trim() ?? '' })
    else if (last && /^\s+\S/.test(line)) last.text = `${last.text} ${line.trim()}`.trim()
  }
  return rules.filter((rule) => rule.text)
}

/**
 * Path globs listed under a `## Ignore` (or `## Skip`) heading of REVIEW.md, one per bullet, with
 * or without backticks. Added to the review's `ignore` option.
 */
export function ignoredInReviewMd(text: string): string[] {
  const globs: string[] = []
  let inSection = false
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim())
    if (heading) {
      inSection = /^(ignore|skip)\b/i.test(heading[1] ?? '')
      continue
    }
    if (!inSection) continue
    const bullet = /^\s*[-*]\s+`?([^`\s]+)`?/.exec(line)
    if (bullet?.[1]) globs.push(bullet[1])
  }
  return globs
}
