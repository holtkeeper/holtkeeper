import { expect, test } from 'bun:test'

import { parseGoTestEvents } from './gotest.ts'

const events = (...list: object[]) => list.map((event) => JSON.stringify(event)).join('\n')

// Shapes from `go test -json -coverprofile=… ./...` (Go 1.27) on a made-up module.
const RUN = events(
  {
    ImportPath: 'example.org/zz/missing',
    Action: 'build-output',
    Output: '# example.com/acme/store\n',
  },
  {
    ImportPath: 'example.org/zz/missing',
    Action: 'build-output',
    Output: 'store/s.go:2:8: cannot find module providing package example.org/zz/missing\n',
  },
  { ImportPath: 'example.org/zz/missing', Action: 'build-fail' },
  { Action: 'start', Package: 'example.com/acme/store' },
  {
    Action: 'output',
    Package: 'example.com/acme/store',
    Output: 'FAIL\texample.com/acme/store [setup failed]\n',
  },
  { Action: 'fail', Package: 'example.com/acme/store', FailedBuild: 'example.org/zz/missing' },
  {
    ImportPath: 'example.com/acme/gear [example.com/acme/gear.test]',
    Action: 'build-output',
    Output: 'gear/g_test.go:3:27: undefined: Spin\n',
  },
  {
    Action: 'output',
    Package: 'example.com/acme/gear',
    Output: 'FAIL\texample.com/acme/gear [build failed]\n',
  },
  {
    Action: 'fail',
    Package: 'example.com/acme/gear',
    FailedBuild: 'example.com/acme/gear [example.com/acme/gear.test]',
  },
  { Action: 'run', Package: 'example.com/acme/calc', Test: 'TestAdd' },
  { Action: 'fail', Package: 'example.com/acme/calc', Test: 'TestAdd' },
  {
    Action: 'output',
    Package: 'example.com/acme/calc',
    Output: 'FAIL\texample.com/acme/calc\t0.2s\n',
  },
  { Action: 'fail', Package: 'example.com/acme/calc', Elapsed: 0.2 },
  {
    Action: 'output',
    Package: 'example.com/acme/ok',
    Output: 'ok  \texample.com/acme/ok\t(cached)\tcoverage: 100.0% of statements\n',
  },
  { Action: 'pass', Package: 'example.com/acme/ok', Elapsed: 0 },
  {
    Action: 'output',
    Package: 'example.com/acme/none',
    Output: '\texample.com/acme/none\t\tcoverage: 0.0% of statements\n',
  },
  { Action: 'pass', Package: 'example.com/acme/none' },
  {
    Action: 'output',
    Package: 'example.com/acme/old',
    Output: '?   \texample.com/acme/old\t[no test files]\n',
  },
  { Action: 'skip', Package: 'example.com/acme/old' },
  {
    Action: 'output',
    Package: 'example.com/acme/slow',
    Output: 'panic: test timed out after 5m0s\n',
  },
  { Action: 'fail', Package: 'example.com/acme/slow' },
)

test('sorts packages into ran, failed, without tests and not run', () => {
  const outcome = parseGoTestEvents(`go: downloading example.org/zz v1.0.0\n${RUN}\n`)
  expect(outcome.ran).toEqual(['example.com/acme/calc', 'example.com/acme/ok'])
  expect(outcome.failed).toEqual(['example.com/acme/calc'])
  expect(outcome.noTests).toEqual(['example.com/acme/none', 'example.com/acme/old'])
  expect(outcome.notRun).toEqual([
    {
      pkg: 'example.com/acme/store',
      reason: 'setup failed',
      error: 'store/s.go:2:8: cannot find module providing package example.org/zz/missing',
    },
    {
      pkg: 'example.com/acme/gear',
      reason: 'build failed',
      error: 'gear/g_test.go:3:27: undefined: Spin',
    },
    { pkg: 'example.com/acme/slow', reason: 'timed out' },
  ])
  expect(outcome.buildOutput).toContain('undefined: Spin')
})

test('a pattern that loads no module fails as a whole', () => {
  const outcome = parseGoTestEvents(
    events(
      {
        ImportPath: './...',
        Action: 'build-output',
        Output: 'pattern ./...: directory prefix . does not contain main module\n',
      },
      { Action: 'output', Package: './...', Output: 'FAIL\t./... [setup failed]\n' },
      { Action: 'fail', Package: './...', FailedBuild: './...' },
    ),
  )
  expect(outcome.ran).toEqual([])
  expect(outcome.notRun[0]).toMatchObject({ pkg: './...', reason: 'setup failed' })
})
