import { describe, expect, test } from 'bun:test'

import {
  MergeRequestCommentsOffError,
  commentsOffDefinition,
  commentsOffForge,
} from './comments-off.ts'
import type { ForgeDefinition, GitForge } from './types.ts'

function fakeForge() {
  const calls: string[] = []
  const record = (name: string) => async () => {
    calls.push(name)
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the methods under test
  const forge = {
    kind: 'fake',
    readFile: async () => 'content',
    commentOnMergeRequest: record('commentOnMergeRequest'),
    replyToDiscussion: record('replyToDiscussion'),
    updateMergeRequest: async () => {
      calls.push('updateMergeRequest')
      return { id: 1 }
    },
  } as unknown as GitForge
  return { forge, calls }
}

const quiet = (repo: string) => repo.startsWith('quiet/')

describe('commentsOffForge', () => {
  test('rejects notes on merge requests of repositories whose comments are off', async () => {
    const { forge, calls } = fakeForge()
    const guarded = commentsOffForge(forge, async (repo) => quiet(repo))
    const error = await guarded.commentOnMergeRequest('quiet/app', 1, 'hi').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MergeRequestCommentsOffError)
    expect(error).toMatchObject({ repo: 'quiet/app', operation: 'commentOnMergeRequest' })
    expect(
      await guarded.replyToDiscussion?.('quiet/app', 1, 'd1', 'hi').catch((e: unknown) => e),
    ).toBeInstanceOf(MergeRequestCommentsOffError)
    expect(calls).toEqual([])
  })

  test('lets merge request updates, reads and other repositories through', async () => {
    const { forge, calls } = fakeForge()
    const guarded = commentsOffForge(forge, quiet)
    await guarded.updateMergeRequest('quiet/app', 1, { description: 'Own text' })
    expect(await guarded.readFile('quiet/app', 'a.txt')).toBe('content')
    await guarded.commentOnMergeRequest('loud/app', 1, 'hi')
    expect(calls).toEqual(['updateMergeRequest', 'commentOnMergeRequest'])
    expect('submitReview' in guarded).toBe(false)
  })

  test('guards every client of a definition', async () => {
    const { forge } = fakeForge()
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only create is used
    const definition = { create: () => forge } as unknown as ForgeDefinition
    const client = commentsOffDefinition(definition, quiet).create()
    expect(
      await client.commentOnMergeRequest('quiet/app', 1, 'hi').catch((e: unknown) => e),
    ).toBeInstanceOf(MergeRequestCommentsOffError)
  })
})
