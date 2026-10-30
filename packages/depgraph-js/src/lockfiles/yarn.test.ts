import { expect, test } from 'bun:test'

import { parseClassicEntries } from './yarn.ts'

test('parses quoted, scoped and multi-descriptor yarn v1 entries', () => {
  const entries = parseClassicEntries(
    [
      '# yarn lockfile v1',
      '',
      '"@babel/core@^7.0.0", "@babel/core@^7.1.0":',
      '  version "7.2.0"',
      '  dependencies:',
      '    "@babel/types" "^7.2.0"',
      '    debug "^4.1.0"',
      '  optionalDependencies:',
      '    fsevents "~2.3.2"',
      '',
      'debug@^4.1.0:',
      '  version "4.3.4"',
      '  resolved "https://registry.yarnpkg.com/debug/-/debug-4.3.4.tgz#1319f6579357f2338d3337d2cdd4914bb5dcc664"',
    ].join('\n'),
  )
  expect([...entries.keys()]).toEqual(['@babel/core@^7.0.0', '@babel/core@^7.1.0', 'debug@^4.1.0'])
  expect(entries.get('@babel/core@^7.1.0')).toEqual({
    name: '@babel/core',
    version: '7.2.0',
    dependencies: { '@babel/types': '^7.2.0', debug: '^4.1.0' },
    optionalDependencies: { fsevents: '~2.3.2' },
  })
  expect(entries.get('debug@^4.1.0')?.version).toBe('4.3.4')
})
