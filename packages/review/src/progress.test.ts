import { describe, expect, test } from 'bun:test'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { Discussion, GitForge } from '@holtkeeper/forge'
import { memoryMessageStore } from '@holtkeeper/messages'
import type { AnalysisStore } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { addedFile, fakeAgent, fakeForge } from '../test/fakes.ts'
import { createReviewAnalyzer, reviewLocale, reviewOptionsSchema } from './analyzer.ts'
import { englishReviewMessages, reviewMessageCatalog } from './messages.ts'
import {
  PROGRESS_MARKER,
  STAGE_MINUTES,
  minutesLeft,
  progressText,
  startProgress,
} from './progress.ts'

const repo = { forge: 'work', path: 'toys/shelf' }

/** A forge with editable standalone notes on top of `fakeForge`. */
function noteForge(options: { discussions?: Discussion[]; canDelete?: boolean } = {}) {
  const base = fakeForge({
    files: [
      {
        oldPath: 'src/widget.ts',
        newPath: 'src/widget.ts',
        status: 'added',
        diff: addedFile(['export const widget = 1']),
      },
    ],
    discussions: options.discussions ?? [],
  })
  const notes = new Map<number, string>()
  const deleted: number[] = []
  const events: string[] = []
  let next = 100
  const forge: GitForge = {
    ...base.forge,
    getCurrentUser: async () => ({ username: 'shelf-bot', name: 'Shelf bot' }),
    postMergeRequestNote: async (_repo, _id, body) => {
      const noteId = next++
      notes.set(noteId, body)
      events.push('post')
      return { noteId }
    },
    updateMergeRequestNote: async (_repo, _id, noteId, body) => {
      notes.set(noteId, body)
      events.push('update')
    },
    submitReview: async (...args) => {
      events.push('review')
      return base.forge.submitReview?.(...args) ?? { posted: 0, failed: [] }
    },
    ...(options.canDelete !== false && {
      deleteMergeRequestNote: async (_repo: string, _id: number, noteId: number) => {
        notes.delete(noteId)
        deleted.push(noteId)
        events.push('delete')
      },
    }),
  }
  return { ...base, forge, notes, deleted, events }
}

const leftover = (author: string, id: number): Discussion => ({
  id: `d${id}`,
  resolvable: false,
  resolved: false,
  notes: [
    {
      id,
      author,
      body: `Still running\n\n${PROGRESS_MARKER}`,
      createdAt: '',
      system: false,
    },
  ],
})

describe('startProgress', () => {
  test('posts the note, deletes our leftovers first and removes it when done', async () => {
    const { forge, notes, deleted } = noteForge({
      discussions: [leftover('Shelf-Bot', 5), leftover('someone', 6)],
    })
    const progress = await startProgress({
      forge,
      repo: repo.path,
      mergeRequest: 7,
      messages: englishReviewMessages,
      owner: 'shelf-bot',
    })
    expect(deleted).toEqual([5])
    expect([...notes.values()][0]).toContain('Holtkeeper is reviewing this merge request')
    expect([...notes.values()][0]).toContain(PROGRESS_MARKER)
    await progress.finish()
    expect(notes.size).toBe(0)
  })

  test('says the review finished or failed where notes cannot be deleted', async () => {
    const { forge, notes } = noteForge({ canDelete: false })
    const done = await startProgress({
      forge,
      repo: repo.path,
      mergeRequest: 7,
      messages: englishReviewMessages,
    })
    await done.finish()
    expect([...notes.values()][0]).toContain('has finished')
    const failed = await startProgress({
      forge,
      repo: repo.path,
      mergeRequest: 7,
      messages: englishReviewMessages,
    })
    await failed.fail()
    expect([...notes.values()][1]).toContain('`/holtkeeper review`')
  })

  test('shows the stage, edits only when the text changes and stops editing once done', async () => {
    const { forge, notes, events } = noteForge({ canDelete: false })
    const progress = await startProgress({
      forge,
      repo: repo.path,
      mergeRequest: 7,
      messages: englishReviewMessages,
    })
    progress.update({ stage: 'review', parts: 3, done: 0, deep: true })
    progress.update({ stage: 'review', parts: 3, done: 0, deep: true })
    progress.update({ stage: 'review', parts: 3, done: 1, deep: true })
    await Bun.sleep(0)
    expect([...notes.values()][0]).toContain('3 parts: 1 done')
    // An edit still queued when the review ends is dropped.
    progress.update({ stage: 'cross', parts: 3, deep: true })
    await progress.finish()
    progress.update({ stage: 'post' })
    await Bun.sleep(0)
    expect(events).toEqual(['post', 'update', 'update', 'update'])
    expect([...notes.values()][0]).toContain('has finished')
  })

  test('a forge that refuses notes does not stop the review', async () => {
    const { forge } = noteForge()
    const logs: string[] = []
    const progress = await startProgress({
      forge: {
        ...forge,
        postMergeRequestNote: async () => {
          throw new Error('comments are off')
        },
      },
      repo: repo.path,
      mergeRequest: 7,
      messages: englishReviewMessages,
      log: (line) => logs.push(line),
    })
    await progress.finish()
    expect(logs[0]).toContain('comments are off')
  })
})

/** Runs the review analyzer on `forge` with a fake agent. */
const run = async (
  forge: GitForge,
  options: Record<string, unknown> = {},
  deps: Parameters<typeof createReviewAnalyzer>[0] = {},
  agentOutputs: Record<string, unknown[]> = {},
  history?: { analyses: AnalysisStore },
) => {
  const { agent, tasks } = fakeAgent(agentOutputs)
  const analyzer = createReviewAnalyzer(deps)
  const result = await analyzer.run({
    repo,
    forge,
    runner: createFakeRunner().runner,
    agent,
    ...(history && { history }),
    options: reviewOptionsSchema.parse({ mergeRequest: 7, includeChecks: false, ...options }),
  })
  return { result, tasks }
}

describe('review analyzer texts', () => {
  test('posts the progress note before the review and deletes it after', async () => {
    const { forge, events, submissions, notes } = noteForge()
    await run(forge)
    // The note says it is posting, then goes away.
    expect(events).toEqual(['post', 'update', 'review', 'delete'])
    expect(notes.size).toBe(0)
    expect(submissions[0]?.summary).toContain('Holtkeeper learns from your answers')
  })

  test('progressNote never posts no progress note', async () => {
    const { forge, events } = noteForge()
    await run(forge, { progressNote: 'never' })
    expect(events).toEqual(['review'])
  })

  test('by default only the first review of a merge request gets the note', async () => {
    const store = memoryStore()
    const history = { analyses: store.analyses }
    const first = noteForge()
    const { result } = await run(first.forge, {}, {}, {}, history)
    expect(first.events[0]).toBe('post')
    await store.analyses.add({
      repo,
      kind: 'review',
      ref: '!7',
      createdAt: '2026-10-30T00:00:00Z',
      data: result.data,
    })
    const later = noteForge()
    await run(later.forge, {}, {}, {}, history)
    expect(later.events).not.toContain('post')
    const always = noteForge()
    await run(always.forge, { progressNote: 'always' }, {}, {}, history)
    expect(always.events[0]).toBe('post')
  })

  test('marks the note failed when the review throws', async () => {
    const { forge, notes } = noteForge()
    const failing: GitForge = {
      ...forge,
      getMergeRequestDiff: async () => {
        throw new Error('forge down')
      },
    }
    const error = await run(failing).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(Error)
    expect([...notes.values()][0]).toContain('could not finish')
  })

  test('translates the fixed texts once into the description language and uses them', async () => {
    const { forge, submissions, notes } = noteForge()
    const store = memoryMessageStore()
    const translation = Object.entries(reviewMessageCatalog.messages).map(([key, message]) => ({
      key,
      text: `RU ${message.text}`,
    }))
    const { result, tasks } = await run(
      forge,
      { language: 'Russian' },
      { messages: store },
      { translate: [{ items: translation }] },
    )
    expect(tasks.map((task) => task.taskKind)).toEqual(['translate'])
    expect(submissions[0]?.summary).toContain('RU _Holtkeeper learns from your answers')
    expect(notes.size).toBe(0)
    expect(result.data.usage?.turns).toBe(2)
    expect(await store.locales('review')).toEqual(['ru'])
  })

  test('reviewLocale prefers the option, then the description', () => {
    expect(reviewLocale('de', 'Добавляет виджеты на полку и кеширует их')).toBe('de')
    expect(reviewLocale(undefined, 'Добавляет виджеты на полку и кеширует их')).toBe('ru')
    expect(reviewLocale(undefined, '')).toBe('en')
  })
})

describe('progressText', () => {
  test('lists the steps with the current one and the time left', () => {
    const text = progressText(
      { stage: 'review', parts: 3, done: 1, deep: true },
      1,
      englishReviewMessages,
    )
    expect(text).toContain('~6 min left.')
    expect(text).toContain('- ⏳ Reviewing the changes in 3 parts: 1 done')
    expect(text).toContain('- ▫️ Final pass over the whole merge request')
    expect(text).toContain('- ▫️ Double-checking the findings')
    expect(text).toContain('- ▫️ Posting comments and the summary')
    const verifying = progressText({ stage: 'verify', findings: 4 }, 0, englishReviewMessages)
    expect(verifying).toContain('- ✅ Reviewing the changes\n')
    expect(verifying).toContain('- ⏳ Double-checking 4 finding(s)')
    expect(verifying).not.toContain('Final pass')
  })

  test('a single pass has no cross-part step, and without verification no verify step', () => {
    const text = progressText(
      { stage: 'review', parts: 1, done: 0, deep: false },
      0,
      englishReviewMessages,
      false,
    )
    expect(text).not.toContain('Final pass')
    expect(text).not.toContain('Double-checking')
  })
})

describe('minutesLeft', () => {
  test('counts what is left of the stage, at least a minute, plus the steps after it', () => {
    const split = { stage: 'review', parts: 4, done: 0, deep: true } as const
    expect(minutesLeft(split, 0, true)).toBe(
      STAGE_MINUTES.part + STAGE_MINUTES.cross.deep + STAGE_MINUTES.verify + STAGE_MINUTES.post,
    )
    expect(minutesLeft(split, 30, true)).toBe(
      1 + STAGE_MINUTES.cross.deep + STAGE_MINUTES.verify + STAGE_MINUTES.post,
    )
    expect(minutesLeft({ stage: 'review', parts: 1, done: 0, deep: false }, 0, false)).toBe(
      STAGE_MINUTES.single.main + STAGE_MINUTES.post,
    )
    expect(minutesLeft({ stage: 'review', parts: 7, done: 0, deep: false }, 0, false)).toBe(
      2 * STAGE_MINUTES.part + STAGE_MINUTES.cross.main + STAGE_MINUTES.post,
    )
    expect(minutesLeft({ stage: 'post' }, 0, true)).toBe(1)
  })
})
