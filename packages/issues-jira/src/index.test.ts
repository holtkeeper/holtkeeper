import { describe, expect, test } from 'bun:test'

import {
  JiraApiError,
  jiraFromCredential,
  jiraTracker,
  validateJiraCredentialOptions,
} from './index.ts'

type Handler = (url: URL, init: RequestInit) => Response

const fakeFetch = (handler: Handler) => {
  const requests: { url: URL; init: RequestInit }[] = []
  const fetch = async (input: string, init: RequestInit) => {
    const url = new URL(input)
    requests.push({ url, init })
    return handler(url, init)
  }
  return { fetch, requests }
}

const raw = (key: string, summary: string, category = 'indeterminate') => ({
  key,
  fields: {
    summary,
    status: {
      name: category === 'done' ? 'Done' : 'In progress',
      statusCategory: { key: category },
    },
    issuetype: { name: 'Story' },
  },
})

const json = (body: unknown, status = 200) => Response.json(body, { status })

describe('jiraTracker', () => {
  test('searches keys in one batch on Cloud and maps status categories', async () => {
    const { fetch, requests } = fakeFetch(() =>
      json({ issues: [raw('ABC-1', 'Round the corners', 'done'), raw('ABC-2', 'Add a widget')] }),
    )
    const tracker = jiraTracker({
      url: 'https://widgets.atlassian.net/',
      auth: { kind: 'basic', email: 'bot@example.com', token: 'secret' },
      fetch,
    })
    const issues = await tracker.issues(['ABC-1', 'ABC-2', 'not a key', 'ABC-1'])
    expect(issues).toEqual([
      {
        key: 'ABC-1',
        title: 'Round the corners',
        status: 'Done',
        category: 'done',
        type: 'Story',
        url: 'https://widgets.atlassian.net/browse/ABC-1',
      },
      {
        key: 'ABC-2',
        title: 'Add a widget',
        status: 'In progress',
        category: 'doing',
        type: 'Story',
        url: 'https://widgets.atlassian.net/browse/ABC-2',
      },
    ])
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request?.url.pathname).toBe('/rest/api/3/search/jql')
    expect(request?.url.searchParams.get('jql')).toBe('key in (ABC-1,ABC-2)')
    expect(request?.init.redirect).toBe('error')
    expect(new Headers(request?.init.headers).get('authorization')).toBe(
      `Basic ${btoa('bot@example.com:secret')}`,
    )
  })

  test('falls back to one request per key when the search names a missing key', async () => {
    const { fetch, requests } = fakeFetch((url) => {
      if (url.pathname.endsWith('/search')) return json({ errorMessages: ['no ABC-9'] }, 400)
      if (url.pathname.endsWith('/ABC-9')) return json({}, 404)
      return json(raw('ABC-1', 'Round the corners'))
    })
    const tracker = jiraTracker({
      url: 'https://tracker.example.com/jira',
      auth: { kind: 'bearer', token: 'pat' },
      fetch,
    })
    const issues = await tracker.issues(['ABC-1', 'ABC-9'])
    expect(issues.map((issue) => issue.key)).toEqual(['ABC-1'])
    expect(requests.map((request) => request.url.pathname)).toEqual([
      '/jira/rest/api/2/search',
      '/jira/rest/api/2/issue/ABC-1',
      '/jira/rest/api/2/issue/ABC-9',
    ])
    expect(requests[0]?.url.searchParams.get('validateQuery')).toBe('warn')
  })

  test('sends only keys of the allowed projects', async () => {
    const { fetch, requests } = fakeFetch(() => json({ issues: [] }))
    const tracker = jiraTracker({
      url: 'https://widgets.atlassian.net',
      auth: { kind: 'bearer', token: 'pat' },
      projects: ['ABC'],
      fetch,
    })
    await tracker.issues(['ABC-1', 'XYZ-2', 'ABCD-3'])
    expect(requests.map((request) => request.url.searchParams.get('jql'))).toEqual([
      'key in (ABC-1)',
    ])
    expect(await tracker.issues(['XYZ-2'])).toEqual([])
    expect(requests).toHaveLength(1)
  })

  test('reports other failures without the credentials', async () => {
    const { fetch } = fakeFetch(() => json({ errorMessages: ['nope'] }, 401))
    const tracker = jiraTracker({
      url: 'https://widgets.atlassian.net',
      auth: { kind: 'bearer', token: 'pat-secret' },
      fetch,
    })
    const error = await tracker.issues(['ABC-1']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(JiraApiError)
    expect((error as JiraApiError).status).toBe(401)
    expect((error as Error).message).not.toContain('pat-secret')
  })
})

describe('jira credentials', () => {
  test('validates options of jira credentials only', () => {
    expect(validateJiraCredentialOptions('gitlab', {})).toBeUndefined()
    expect(validateJiraCredentialOptions('jira', { authKind: 'bearer' })).toEqual([])
    expect(validateJiraCredentialOptions('jira', { authKind: 'basic', email: 'x' })).toEqual([
      'options.email: must be an email address',
    ])
    expect(
      validateJiraCredentialOptions('jira', { authKind: 'bearer', projects: ['ABC', 'abc'] }),
    ).toEqual(['options.projects.1: must be a project key like ABC'])
  })

  test('builds a tracker from a credential', async () => {
    const { fetch, requests } = fakeFetch(() => json({ issues: [] }))
    const tracker = jiraFromCredential(
      { kind: 'jira', url: 'https://widgets.atlassian.net', options: { authKind: 'bearer' } },
      'pat',
      { fetch },
    )
    expect(await tracker.issues(['ABC-1'])).toEqual([])
    expect(new Headers(requests[0]?.init.headers).get('authorization')).toBe('Bearer pat')
    expect(() => jiraFromCredential({ kind: 'confluence', url: 'https://x' }, 'pat')).toThrow()
  })
})
