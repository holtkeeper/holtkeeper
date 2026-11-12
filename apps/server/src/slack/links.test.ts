import { expect, test } from 'bun:test'

import { mergeRequestLinks } from './links.ts'

const forges = {
  acme: { url: 'https://git.acme.test' },
  nested: { url: 'https://tools.acme.test/gitlab/' },
}

test('reads Slack-wrapped, labeled and bare links, each merge request once', () => {
  const text = [
    'please look <https://git.acme.test/shapes/widget/-/merge_requests/7|Widget !7>',
    'and <https://git.acme.test/shapes/widget/-/merge_requests/7/diffs>',
    'also https://git.acme.test/shapes/sub/gadget/-/merge_requests/12?tab=notes.',
  ].join('\n')
  expect(mergeRequestLinks(text, forges)).toEqual([
    {
      repo: { forge: 'acme', path: 'shapes/widget' },
      mergeRequest: 7,
      url: 'https://git.acme.test/shapes/widget/-/merge_requests/7',
    },
    {
      repo: { forge: 'acme', path: 'shapes/sub/gadget' },
      mergeRequest: 12,
      url: 'https://git.acme.test/shapes/sub/gadget/-/merge_requests/12?tab=notes',
    },
  ])
})

test('keeps a forge under a path prefix apart', () => {
  expect(
    mergeRequestLinks('<https://tools.acme.test/gitlab/tools/gizmo/-/merge_requests/3>', forges),
  ).toEqual([
    {
      repo: { forge: 'nested', path: 'tools/gizmo' },
      mergeRequest: 3,
      url: 'https://tools.acme.test/gitlab/tools/gizmo/-/merge_requests/3',
    },
  ])
})

test('ignores unknown hosts and paths that are not merge requests', () => {
  const text = [
    '<https://elsewhere.test/shapes/widget/-/merge_requests/7>',
    '<https://git.acme.test/shapes/widget/-/issues/7>',
    '<https://git.acme.test/shapes/widget/-/merge_requests/new>',
    '<https://tools.acme.test/other/widget/-/merge_requests/2>',
  ].join(' ')
  expect(mergeRequestLinks(text, forges)).toEqual([])
})
