import type { ChangelogLinks } from '@holtkeeper/changelog'

import { checkGates } from './gates.ts'
import { buildEntries, digestSummary, renderChangelog, suggestBump } from './notes.ts'
import type { ReleaseSettings } from './settings.ts'
import { fillTemplate } from './template.ts'
import type { GateResult, ReleaseEdits, ReleaseFacts, ReleasePlan } from './types.ts'
import { isValidVersion, nextVersion, tagName } from './version.ts'

/** Hidden marker in descriptions of merge requests Holtkeeper opened as release candidates. */
export const releaseMarker = '<!-- holtkeeper:release -->'

const tidy = (text: string) => text.replace(/\n{3,}/gu, '\n\n').trim()

export interface PlanOptions {
  step: 'propose' | 'version'
  facts: ReleaseFacts
  settings: ReleaseSettings
  edits?: ReleaseEdits
  links?: ChangelogLinks
  now: Date
}

/**
 * What a step would do now: the changes of its range as changelog entries, the suggested and the
 * chosen version, summary, title and body from the settings' templates, and the gates. `propose`
 * covers the source branch's commits not on the target; `version` the target's commits since
 * the latest version. A person's `edits` win over suggestions.
 */
export function planRelease({
  step,
  facts,
  settings,
  edits = {},
  links,
  now,
}: PlanOptions): ReleasePlan {
  const propose = step === 'propose'
  const commits = propose ? facts.ahead : facts.unreleased
  const range = propose
    ? {
        from: facts.target.sha,
        to: facts.source?.sha ?? facts.target.sha,
        fromLabel: facts.target.name,
        toLabel: facts.source?.name ?? settings.flow.source,
      }
    : {
        ...(facts.latest ? { from: facts.latest.sha, fromLabel: facts.latest.tag } : {}),
        to: facts.target.sha,
        toLabel: facts.target.name,
      }
  const labels = (propose ? facts.request?.labels : facts.merged?.labels) ?? []
  const entries = buildEntries(commits, settings.changelog, edits)
  const suggestedBump = suggestBump(entries, settings.version.bump, {
    ...(facts.latest ? { current: facts.latest.version } : {}),
    labels,
  })
  const suggestedVersion = nextVersion(
    settings,
    facts.latest?.version,
    suggestedBump.bump,
    facts.versions,
    now,
  )
  const version = edits.version ?? suggestedVersion
  const tag = version ? tagName(settings.version.tagFormat, version) : undefined
  const compareUrl = range.from && links ? links.compare(range.from, range.to) : undefined
  const changelog = renderChangelog(entries, settings.changelog, links)
  const summary =
    edits.summary !== undefined
      ? { markdown: edits.summary.markdown, source: edits.summary.source }
      : settings.summary.mode === 'off'
        ? { markdown: '', source: 'none' as const }
        : { markdown: digestSummary(entries), source: 'changelog' as const }

  const values = {
    version,
    tag,
    next: version ?? 'none',
    previous: facts.latest?.version ?? 'none',
    previousTag: facts.latest?.tag ?? 'none',
    source: facts.source?.name ?? settings.flow.source,
    target: facts.target.name,
    repo: facts.repo.path,
    summary: summary.markdown,
    changelog,
    compare: compareUrl ?? '',
    commits: String(commits.length),
  }
  const fill = (template: string) => fillTemplate(template, values, now, settings.timezone)
  const title = propose
    ? (edits.title ?? fill(settings.mergeRequest.title))
    : fill(settings.tag.releaseName)
  const body = propose
    ? `${tidy(fill(settings.mergeRequest.description))}\n\n${releaseMarker}`
    : tidy(fill(settings.tag.notes))

  const gates: GateResult[] = checkGates(step, settings, facts, now)
  const included = entries.filter((entry) => entry.included).length
  if (commits.length === 0) gates.unshift({ id: 'empty', ok: false, message: 'nothing to release' })
  else if (included === 0)
    gates.unshift({ id: 'empty', ok: false, message: 'every change is left out' })
  if (!propose) {
    if (!version) gates.push({ id: 'tag-exists', ok: false, message: 'no version chosen' })
    else if (!isValidVersion(settings, version))
      gates.push({ id: 'tag-exists', ok: false, message: `${version} is not a valid version` })
    else if (facts.versions.some((existing) => existing.tag === tag))
      gates.push({ id: 'tag-exists', ok: false, message: `tag ${tag} already exists` })
  }

  return {
    step,
    range,
    ...(compareUrl ? { compareUrl } : {}),
    entries,
    commitCount: commits.length,
    capped: propose ? facts.aheadCapped : facts.unreleasedCapped,
    ...(facts.latest ? { current: facts.latest } : {}),
    suggested: {
      bump: suggestedBump.bump,
      ...(suggestedVersion ? { version: suggestedVersion } : {}),
      reasons: suggestedBump.reasons,
    },
    ...(version ? { version } : {}),
    ...(tag ? { tag } : {}),
    summary,
    changelog,
    title,
    body,
    gates,
    edits,
  }
}

/** Gates a step may never override: an empty release or an unusable version. */
export const hardGates = new Set<GateResult['id']>(['empty', 'tag-exists'])

/** Failing gates that block the step: every failing one without `force`, the hard ones always. */
export const blockingGates = (gates: readonly GateResult[], force: boolean) =>
  gates.filter((gate) => !gate.ok && (!force || hardGates.has(gate.id)))
