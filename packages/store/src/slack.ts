import type { SlackMessageLink, SlackMessageStore, SlackStatusReply } from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Links of one message in a stable order: by repository, then merge request. */
export const byLinkTarget = (a: SlackMessageLink, b: SlackMessageLink) =>
  binary(a.repo, b.repo) || a.mergeRequest - b.mergeRequest

/** Links to one merge request in a stable order: oldest message first. */
export const byLinkMessage = (a: SlackMessageLink, b: SlackMessageLink) =>
  binary(a.createdAt, b.createdAt) || binary(a.channel, b.channel) || binary(a.ts, b.ts)

const linkKey = (link: Pick<SlackMessageLink, 'channel' | 'ts' | 'repo' | 'mergeRequest'>) =>
  `${link.channel}\u0000${link.ts}\u0000${link.repo}\u0000${link.mergeRequest}`

const replyKey = (channel: string, ts: string) => `${channel}\u0000${ts}`

/** The in-memory `SlackMessageStore`. */
export function memorySlackMessages(): SlackMessageStore {
  const links = new Map<string, SlackMessageLink>()
  const replies = new Map<string, SlackStatusReply>()
  return {
    async put(link) {
      links.set(linkKey(link), clone(link))
    },
    ofMessage: async (channel, ts) =>
      [...links.values()]
        .filter((link) => link.channel === channel && link.ts === ts)
        .toSorted(byLinkTarget)
        .map(clone),
    ofMergeRequest: async (repo, mergeRequest) =>
      [...links.values()]
        .filter((link) => link.repo === repo && link.mergeRequest === mergeRequest)
        .toSorted(byLinkMessage)
        .map(clone),
    async delete(channel, ts, target) {
      let deleted = 0
      for (const [key, link] of links)
        if (
          link.channel === channel &&
          link.ts === ts &&
          (!target || (link.repo === target.repo && link.mergeRequest === target.mergeRequest))
        ) {
          links.delete(key)
          deleted++
        }
      if (!target) replies.delete(replyKey(channel, ts))
      return deleted
    },
    replyOf: async (channel, ts) => {
      const reply = replies.get(replyKey(channel, ts))
      return reply && clone(reply)
    },
    async putReply(reply) {
      replies.set(replyKey(reply.channel, reply.ts), clone(reply))
    },
    async prune(before) {
      let deleted = 0
      for (const [key, link] of links)
        if (link.createdAt < before) {
          links.delete(key)
          deleted++
        }
      const linked = new Set([...links.values()].map((link) => replyKey(link.channel, link.ts)))
      for (const [key, reply] of replies)
        if (reply.createdAt < before && !linked.has(key)) replies.delete(key)
      return deleted
    },
  }
}
