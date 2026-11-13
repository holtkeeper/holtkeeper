import { describe, expect, test } from 'bun:test'

import { fleetPackagesOf } from '../src/fleet-packages.ts'

describe('fleetPackagesOf', () => {
  test('npm packages by name, Go packages by module, removed packages left out', () => {
    const kit = { forge: 'work', path: 'acme/kit' }
    const web = { forge: 'work', path: 'acme/widget-ui' }
    expect(
      fleetPackagesOf([
        { name: '@acme/widget-ui', repo: web },
        {
          name: 'example.com/kit/v2/retry',
          ecosystem: 'Go',
          module: 'example.com/kit/v2',
          repo: kit,
        },
        { name: 'example.com/kit/v2/loose', ecosystem: 'Go', repo: kit },
        {
          name: '@acme/old-widget',
          repo: web,
          removed: { at: '2026-10-01T00:00:00.000Z' },
        },
      ]),
    ).toEqual([
      { subject: 'npm:@acme/widget-ui', repo: web },
      { subject: 'Go:example.com/kit/v2', repo: kit },
      { subject: 'Go:example.com/kit/v2/loose', repo: kit },
    ])
  })
})
