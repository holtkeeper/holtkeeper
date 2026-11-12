import { describe, expect, test } from 'bun:test'

import { webPaths, webUrl } from './index.ts'

describe('webPaths', () => {
  test('workspace pages without search parameters', () => {
    expect(webPaths.repos()).toBe('/repos')
    expect(webPaths.runs()).toBe('/ops/runs')
    expect(webPaths.tasks()).toBe('/ops/tasks')
    expect(webPaths.automation()).toBe('/ops/automation')
    expect(webPaths.security()).toBe('/supply/security')
  })

  test('drops empty and undefined search parameters and encodes the rest', () => {
    expect(
      webPaths.runs({ status: 'failed', analyzer: 'widgets', signature: undefined, repo: '' }),
    ).toBe('/ops/runs?status=failed&analyzer=widgets')
    expect(webPaths.releaseTimeline('gitlab:acme/widget-kit')).toBe(
      '/releases/timeline?repo=gitlab%3Aacme%2Fwidget-kit',
    )
    expect(webPaths.automation('nightly')).toBe('/ops/automation?job=nightly')
  })

  test('knowledge tabs take an optional space, section and note', () => {
    expect(webPaths.knowledge('notes')).toBe('/knowledge/notes')
    expect(webPaths.knowledge('learnings', { space: 'repo:gitlab:acme/widget-kit' })).toBe(
      '/knowledge/learnings?space=repo%3Agitlab%3Aacme%2Fwidget-kit',
    )
    expect(webPaths.knowledge('guide', { space: 'group:widgets', section: 'testing' })).toBe(
      '/knowledge/guide?space=group%3Awidgets&section=testing',
    )
    expect(webPaths.knowledge('notes', { note: 'n-1', space: '' })).toBe(
      '/knowledge/notes?note=n-1',
    )
  })

  test('chat opens a thread when given one', () => {
    expect(webPaths.chat()).toBe('/chat')
    expect(webPaths.chat('t 1')).toBe('/chat?thread=t+1')
  })

  test('path parameters are encoded as single segments', () => {
    expect(webPaths.securityRun('run 1')).toBe('/supply/security/runs/run%201')
  })

  test('the repository hub carries the repository in its path', () => {
    expect(webPaths.repo('gitlab:acme/widget-kit')).toBe('/repos/gitlab/acme/widget-kit')
    expect(
      webPaths.repo('gitlab:acme/sub/widget kit', {
        tab: 'quality',
        section: 'assets',
        file: 'img/a b.png',
        ref: '',
      }),
    ).toBe('/repos/gitlab/acme/sub/widget%20kit?tab=quality&section=assets&file=img%2Fa+b.png')
    expect(webPaths.repo('gitlab:acme/widget-kit', { tab: 'settings', section: 'updates' })).toBe(
      '/repos/gitlab/acme/widget-kit?tab=settings&section=updates',
    )
    expect(webPaths.groups()).toBe('/repos/groups')
  })

  test('a task is only selected inside its group', () => {
    expect(webPaths.tasks({ group: 'g-1', task: 't-2' })).toBe('/ops/tasks?group=g-1&task=t-2')
    expect(webPaths.tasks({ task: 't-2' })).toBe('/ops/tasks')
    expect(webPaths.tasks({ filter: 'failed' })).toBe('/ops/tasks?filter=failed')
  })

  test('inbox opens an item, a kind filter or the Snoozed tab', () => {
    expect(webPaths.inbox()).toBe('/inbox')
    expect(webPaths.inbox({ item: 'release:gitlab:acme/widget-kit', kind: 'release' })).toBe(
      '/inbox?item=release%3Agitlab%3Aacme%2Fwidget-kit&kind=release',
    )
    expect(webPaths.inbox({ item: '', tab: 'snoozed' })).toBe('/inbox?tab=snoozed')
  })

  test('settings sections', () => {
    expect(webPaths.settings('integrations')).toBe('/settings/integrations')
    expect(webPaths.settings('audit')).toBe('/settings/audit')
    expect(webPaths.settings('policies')).toBe('/settings/policies')
  })
})

describe('webUrl', () => {
  test('joins the public URL and a path without doubling slashes', () => {
    expect(webUrl('https://hk.acme.dev/', webPaths.runs())).toBe('https://hk.acme.dev/ops/runs')
    expect(webUrl('https://hk.acme.dev//', '/')).toBe('https://hk.acme.dev/')
  })
})
