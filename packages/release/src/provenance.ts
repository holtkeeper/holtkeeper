import type { ReleaseEvent, ReleaseProvenance } from './types.ts'

/**
 * How the version `tag` was cut, from recorded events (newest first, as kept in the history):
 * the newest `versioned` event of the tag and the acceptance it was created on, which is the
 * newest `accepted` event before it and after the previous version naming the same commit when
 * both recorded one. `undefined` when Holtkeeper did not create the version, e.g. a tag made by
 * hand.
 */
export function versionProvenance(
  history: readonly ReleaseEvent[],
  tag: string,
): ReleaseProvenance | undefined {
  const at = history.findIndex((event) => event.kind === 'versioned' && event.tag === tag)
  if (at === -1) return undefined
  const versioned = history[at]!
  let accepted: ReleaseEvent | undefined
  for (const event of history.slice(at + 1)) {
    if (event.kind === 'versioned') break
    if (event.kind !== 'accepted') continue
    if (event.sha && versioned.sha && event.sha !== versioned.sha) continue
    accepted = event
    break
  }
  return {
    ...(accepted
      ? {
          accepted: {
            actor: accepted.actor,
            ...(accepted.actorName ? { actorName: accepted.actorName } : {}),
            ...(accepted.channel ? { channel: accepted.channel } : {}),
            at: accepted.at,
            ...(accepted.via ? { via: accepted.via } : {}),
            ...((accepted.note ?? accepted.detail)
              ? { note: accepted.note ?? accepted.detail }
              : {}),
            ...(accepted.sha ? { sha: accepted.sha } : {}),
          },
        }
      : {}),
    versioned: {
      actor: versioned.actor,
      ...(versioned.actorName ? { actorName: versioned.actorName } : {}),
      ...(versioned.channel ? { channel: versioned.channel } : {}),
      at: versioned.at,
      force: versioned.force ?? false,
      ...(versioned.notes ? { notes: versioned.notes } : {}),
      ...(versioned.changelogSha ? { changelogSha: versioned.changelogSha } : {}),
      ...(versioned.url ? { url: versioned.url } : {}),
    },
  }
}
