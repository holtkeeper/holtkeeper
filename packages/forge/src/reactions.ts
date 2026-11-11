import type { NoteReaction } from './types.ts'

const UP = new Set(['thumbsup', '+1', 'thumbs_up', '👍'])
const DOWN = new Set(['thumbsdown', '-1', 'thumbs_down', '👎'])

/** 👍 and 👎 among `reactions`, whatever the forge calls them; other emoji are not counted. */
export function reactionCounts(reactions: readonly NoteReaction[]): { up: number; down: number } {
  let up = 0
  let down = 0
  for (const reaction of reactions) {
    if (UP.has(reaction.name)) up++
    else if (DOWN.has(reaction.name)) down++
  }
  return { up, down }
}
