import { defineConfig, definePlugin } from '@holtkeeper/core'
import { z } from 'zod'

const greeter = definePlugin({
  name: 'greeter',
  options: z.object({ greeting: z.string().default('hello') }),
  run: async () => {},
})

export default defineConfig({
  forges: {
    work: {
      kind: 'fake',
      url: 'https://forge.test',
      create: () => {
        throw new Error('not used')
      },
    },
  },
  groups: { games: { forge: 'work', include: ['games/*'] } },
  repos: { 'games/app-x': { traits: { ssr: true } } },
  plugins: [greeter({ groups: ['games'], overrides: { 'games/app-*': { greeting: 'hi' } } })],
})
