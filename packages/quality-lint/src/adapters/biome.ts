import { hasAny, hasDependency, projectBinary } from '../detect.ts'
import { parseSarif } from '../sarif.ts'
import type { LinterAdapter } from '../types.ts'

/**
 * Biome 2 through `biome lint --reporter=sarif`, without Biome's default cap of 20 diagnostics.
 * Detected by `biome.json`/`biome.jsonc` or a `@biomejs/biome` dependency.
 */
export const biomeAdapter = (): LinterAdapter => ({
  name: 'biome',
  async detect(dir) {
    return (
      (await hasAny(dir, ['biome.json', 'biome.jsonc'])) || hasDependency(dir, '@biomejs/biome')
    )
  },
  command: (dir) => [
    projectBinary(dir, 'biome'),
    'lint',
    '--reporter=sarif',
    '--max-diagnostics=none',
    '--colors=off',
  ],
  parse: (stdout, dir) => parseSarif(stdout, { dir, tool: 'biome' }),
})
