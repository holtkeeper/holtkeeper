import { expect, test } from 'bun:test'

import { gitlabGitAuthorization, gitlabGitRead } from './git-read.ts'

const allows = (url: string, method: string, host: string, path: string) =>
  gitlabGitRead(url).some(
    (rule) =>
      rule.host === host &&
      rule.methods.includes(method) &&
      rule.paths.some((pattern) => new RegExp(pattern).test(path)),
  )

test('lets go-get discovery and git fetches through, on any group depth', () => {
  for (const [method, path] of [
    ['GET', '/shapes/geom?go-get=1'],
    ['GET', '/shapes/libs/round/geom/v2/internal/x?go-get=1'],
    ['HEAD', '/shapes/libs/geom?go-get=1'],
    ['GET', '/shapes/libs/geom.git/info/refs?service=git-upload-pack'],
    ['GET', '/shapes/libs/geom/info/refs?service=git-upload-pack'],
    ['POST', '/shapes/libs/geom.git/git-upload-pack'],
    ['POST', '/shapes/libs/geom/git-upload-pack'],
  ] as const)
    expect(allows('https://gitlab.example', method, 'gitlab.example', path)).toBe(true)
})

test('never pushes, never reaches the API and never leaves the forge host', () => {
  for (const [method, path] of [
    ['GET', '/shapes/libs/geom.git/info/refs?service=git-receive-pack'],
    ['POST', '/shapes/libs/geom.git/git-receive-pack'],
    ['POST', '/shapes/libs/geom.git/info/refs?service=git-upload-pack'],
    ['GET', '/shapes/libs/geom.git/git-upload-pack'],
    ['PUT', '/shapes/libs/geom.git/git-upload-pack'],
    ['POST', '/shapes/libs/geom?go-get=1'],
    ['GET', '/api/v4/projects/1?go-get=1'],
    ['GET', '/api/v4/user/info/refs?service=git-upload-pack'],
    ['POST', '/api/v4/projects/1/git-upload-pack'],
    ['GET', '/shapes/../api/v4/user?go-get=1'],
    ['GET', '/shapes/%2e%2e/api/v4/user?go-get=1'],
    ['GET', '/geom?go-get=1'],
    ['GET', '/shapes/libs/geom?go-get=1&private_token=x'],
    ['GET', '/shapes/libs/geom/-/raw/main/secret.txt'],
    ['POST', '/shapes/libs/-/create/main/git-upload-pack'],
    ['POST', '/shapes/libs/-/x/1/git-upload-pack'],
    ['GET', '/shapes/libs/-/blob/main?go-get=1'],
    ['GET', '/shapes/libs/-/info/refs?service=git-upload-pack'],
    ['GET', '/shapes/libs/geom.git/info/refs?service=git-upload-pack&x=1'],
  ] as const)
    expect(allows('https://gitlab.example', method, 'gitlab.example', path)).toBe(false)
  expect(allows('https://gitlab.example', 'GET', 'other.example', '/shapes/geom?go-get=1')).toBe(
    false,
  )
})

test('keeps the sub-path of an instance', () => {
  const url = 'https://example.com/gitlab/'
  expect(allows(url, 'GET', 'example.com', '/gitlab/shapes/geom?go-get=1')).toBe(true)
  expect(allows(url, 'POST', 'example.com', '/gitlab/shapes/geom.git/git-upload-pack')).toBe(true)
  expect(allows(url, 'GET', 'example.com', '/shapes/geom?go-get=1')).toBe(false)
  expect(allows(url, 'GET', 'example.com', '/gitlab/api/v4/x/y?go-get=1')).toBe(false)
})

test('authorizes as oauth2 with the token as password', () => {
  expect(gitlabGitAuthorization('glpat-abc')).toBe(
    `Basic ${Buffer.from('oauth2:glpat-abc').toString('base64')}`,
  )
})
