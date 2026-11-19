import { describe, expect, test } from 'bun:test'

import { dependencyPath } from './external-files.ts'

describe('dependencyPath', () => {
  test('names the package a node_modules path points into', () => {
    expect(dependencyPath('node_modules/some-lib/dist/index.d.ts')).toEqual({
      package: 'some-lib',
      ecosystem: 'npm',
      rest: 'dist/index.d.ts',
    })
    expect(dependencyPath('apps/shop/node_modules/@acme/widgets/src/shape.ts')).toEqual({
      package: '@acme/widgets',
      ecosystem: 'npm',
      rest: 'src/shape.ts',
    })
    expect(dependencyPath('node_modules/a/node_modules/@acme/widgets')).toMatchObject({
      package: '@acme/widgets',
      rest: '',
    })
  })

  test('a glob that names no package still counts as a dependency path', () => {
    expect(dependencyPath('**/node_modules/@acme/*/index.ts')).toEqual({
      ecosystem: 'npm',
      rest: '',
    })
    expect(dependencyPath('node_modules/**')).toEqual({ ecosystem: 'npm', rest: '' })
  })

  test('reads the Go module cache and vendored Go packages', () => {
    expect(dependencyPath('/home/dev/go/pkg/mod/example.com/kit@v1.4.0/log/log.go')).toEqual({
      package: 'example.com/kit',
      ecosystem: 'Go',
      version: 'v1.4.0',
      rest: 'log/log.go',
    })
    expect(dependencyPath('vendor/example.com/kit/log/log.go')).toEqual({
      package: 'example.com/kit/log',
      ecosystem: 'Go',
      rest: 'log.go',
    })
  })

  test('leaves the repository’s own paths alone', () => {
    expect(dependencyPath('src/modules/node.ts')).toBeUndefined()
    expect(dependencyPath('vendor/assets/logo.svg')).toBeUndefined()
  })
})
