import { hasAny, hasDependency, projectBinary } from '../detect.ts'
import { parseSarif } from '../sarif.ts'
import type { LinterAdapter } from '../types.ts'

const configs = ['.oxlintrc.json', '.oxlintrc.jsonc', 'oxlint.config.ts']

/**
 * oxlint through `oxlint -f sarif`. Detected by an oxlint config file or an `oxlint` dependency.
 * A fix is `safe` when the rule's fix kind is a plain fix (`fixable_fix`), not a suggestion or a
 * dangerous fix.
 */
export const oxlintAdapter = (): LinterAdapter => ({
  name: 'oxlint',
  async detect(dir) {
    return (await hasAny(dir, configs)) || hasDependency(dir, 'oxlint')
  },
  command: (dir) => [projectBinary(dir, 'oxlint'), '-f', 'sarif'],
  parse: (stdout, dir) =>
    parseSarif(stdout, {
      dir,
      tool: 'oxlint',
      isSafeFix: ({ fix, rule }) =>
        fix.properties?.['safe'] === true || rule?.properties?.['fix'] === 'fixable_fix',
    }),
})
