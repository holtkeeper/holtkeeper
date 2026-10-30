import type { LinkTemplates } from './types.ts'

/** URLs into a forge's web UI. */
export interface ChangelogLinks {
  commit(sha: string): string
  compare(from: string, to: string): string
  mergeRequest(number: number): string
  tag(name: string): string
  /** `#123` goes to the forge's issues, `GTW-435` to the ticket template when there is one. */
  ticket(id: string): string | undefined
  /** The serializable form, for `ChangelogData.links`. */
  templates: LinkTemplates
}

export interface ForgeLinksOptions {
  kind: 'gitlab' | 'github'
  /** Project page, e.g. `https://gitlab.example.com/group/project`. */
  webUrl: string
  /** Tracker URL with `{id}`, e.g. `https://jira.example.com/browse/{id}`. */
  ticketUrl?: string
}

/** Link templates for a GitLab or GitHub project. */
export function forgeLinks({ kind, webUrl, ticketUrl }: ForgeLinksOptions): ChangelogLinks {
  const base = webUrl.replace(/\/+$/u, '')
  const templates: LinkTemplates =
    kind === 'gitlab'
      ? {
          commit: `${base}/-/commit/{sha}`,
          compare: `${base}/-/compare/{from}...{to}`,
          mergeRequest: `${base}/-/merge_requests/{n}`,
          tag: `${base}/-/tags/{name}`,
          issue: `${base}/-/issues/{n}`,
        }
      : {
          commit: `${base}/commit/{sha}`,
          compare: `${base}/compare/{from}...{to}`,
          mergeRequest: `${base}/pull/{n}`,
          tag: `${base}/releases/tag/{name}`,
          issue: `${base}/issues/{n}`,
        }
  if (ticketUrl) templates.ticket = ticketUrl
  return linksFromTemplates(templates)
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
    name in values ? encodeURI(values[name] ?? '') : whole,
  )

/** Rebuilds link functions from stored templates. */
export function linksFromTemplates(templates: LinkTemplates): ChangelogLinks {
  return {
    templates,
    commit: (sha) => fill(templates.commit, { sha }),
    compare: (from, to) => fill(templates.compare, { from, to }),
    mergeRequest: (n) => fill(templates.mergeRequest, { n: String(n) }),
    tag: (name) => fill(templates.tag, { name }),
    ticket(id) {
      const issue = /^#(\d+)$/u.exec(id)
      if (issue) return fill(templates.issue, { n: issue[1] ?? '' })
      return templates.ticket ? fill(templates.ticket, { id }) : undefined
    },
  }
}
