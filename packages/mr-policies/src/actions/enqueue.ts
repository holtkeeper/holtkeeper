import { z } from 'zod'

import { defineAction } from './provider.ts'

const schema = z.object({
  type: z.literal('enqueue'),
  analyzer: z.string().min(1),
  options: z.record(z.string(), z.unknown()).optional(),
})

/** Asks the caller to enqueue an analyzer; the engine itself never touches the job queue. */
export const enqueueAction = defineAction({
  type: 'enqueue',
  schema,
  async run(action) {
    const intent = {
      analyzer: action.analyzer,
      ...(action.options ? { options: action.options } : {}),
    }
    return { status: 'intent', detail: `enqueue ${action.analyzer}`, enqueue: [intent] }
  },
})
