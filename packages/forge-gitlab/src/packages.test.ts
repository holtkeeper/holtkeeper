import { expect, test } from 'bun:test'

import { gitlabPackageRegistry } from './packages.ts'

const matches = (url: string, path: string) =>
  gitlabPackageRegistry(url).paths.some((pattern) => new RegExp(pattern).test(path))

test('covers instance, group and project registries and nothing else', () => {
  expect(gitlabPackageRegistry('https://gitlab.com').host).toBe('gitlab.com')
  for (const path of [
    '/api/v4/packages/npm/@acme/ui.libs',
    '/api/v4/projects/1234567/packages/npm/@acme/ui.libs/-/@acme/ui.libs-7.14.2.tgz',
    '/api/v4/projects/group%2Fproject/packages/maven/com/example/a/1.0/a-1.0.jar',
    '/api/v4/groups/42/-/packages/npm/@scope/pkg',
    '/api/v4/groups/42/-/packages/maven/x',
  ])
    expect(matches('https://gitlab.com', path)).toBe(true)
  for (const path of ['/api/v4/user', '/api/v4/projects/1/repository/files', '/x/api/v4/packages/'])
    expect(matches('https://gitlab.com', path)).toBe(false)
})

test('keeps the sub-path of an instance', () => {
  const location = gitlabPackageRegistry('https://example.com/gitlab/')
  expect(location.host).toBe('example.com')
  expect(matches('https://example.com/gitlab/', '/gitlab/api/v4/packages/npm/a')).toBe(true)
  expect(matches('https://example.com/gitlab/', '/api/v4/packages/npm/a')).toBe(false)
})
