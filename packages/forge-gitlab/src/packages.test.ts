import { expect, test } from 'bun:test'

import { gitlabPackageFiles, gitlabPackageRegistry } from './packages.ts'

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

const cached = (url: string, path: string) =>
  gitlabPackageFiles(url).paths.some((pattern) => new RegExp(pattern).test(path))

test('caches published package files and never indexes, metadata or snapshots', () => {
  for (const path of [
    '/api/v4/projects/1234567/packages/npm/@acme/ui.libs/-/@acme/ui.libs-7.11.6.tgz',
    '/api/v4/projects/1/packages/npm/left-pad/-/left-pad-1.3.0.tgz',
    '/api/v4/projects/1/packages/maven/com/example/app/1.2.0/app-1.2.0.jar',
    '/api/v4/groups/7/-/packages/maven/com/example/app/1.2.0/app-1.2.0.pom.sha1',
    `/api/v4/projects/1/packages/pypi/files/${'a'.repeat(64)}/tool-1.0-py3-none-any.whl`,
    '/api/v4/projects/1/packages/generic/assets/1.0.0/bundle.tar.gz',
  ])
    expect(cached('https://gitlab.com', path)).toBe(true)
  for (const path of [
    '/api/v4/packages/npm/@acme/ui.libs',
    '/api/v4/projects/1/packages/npm/@acme/ui.libs',
    '/api/v4/projects/1/packages/maven/com/example/app/maven-metadata.xml',
    '/api/v4/projects/1/packages/maven/com/example/app/maven-metadata.xml.sha1',
    '/api/v4/projects/1/packages/maven/com/example/app/1.3.0-SNAPSHOT/app-1.3.0-20261031.jar',
    '/api/v4/projects/1/packages/pypi/simple/tool',
    '/api/v4/projects/1/packages/generic/assets/1.0.0',
    '/api/v4/projects/1/repository/archive.tar.gz',
  ])
    expect(cached('https://gitlab.com', path)).toBe(false)
  expect(
    cached('https://example.com/gitlab', '/gitlab/api/v4/projects/1/packages/npm/a/-/a-1.0.0.tgz'),
  ).toBe(true)
})
