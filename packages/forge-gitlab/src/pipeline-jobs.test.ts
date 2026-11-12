import { expect, test } from 'bun:test'

import { gitlab } from './gitlab.ts'

const base = 'https://gitlab.example.com'

const job = (id: number, name: string, stage: string, status: string, extra = {}) => ({
  id,
  name,
  stage,
  status,
  web_url: `${base}/acme/widget/-/jobs/${id}`,
  ...extra,
})

function setup(routes: Record<string, unknown>) {
  const calls: string[] = []
  const forge = gitlab({
    url: base,
    token: 'glpat-test',
    fetch: async (input) => {
      const url = new URL(input)
      calls.push(`${url.pathname}${url.search}`)
      const body = routes[url.pathname]
      return body === undefined
        ? Response.json({ message: '404 Not found' }, { status: 404 })
        : Response.json(body)
    },
  }).create()
  return { forge, calls }
}

test('lists jobs of the latest pipeline of a ref in pipeline order', async () => {
  const { forge, calls } = setup({
    '/api/v4/projects/acme%2Fwidget/pipelines/latest': {
      id: 41,
      ref: 'v1.2.0',
      sha: 'abc',
      status: 'manual',
      web_url: `${base}/acme/widget/-/pipelines/41`,
    },
    '/api/v4/projects/acme%2Fwidget/pipelines/41/jobs': [
      job(903, 'deploy-production', 'deploy', 'manual', { environment: { name: 'production' } }),
      job(902, 'deploy-staging', 'deploy', 'success', {
        when: 'manual',
        environment: { name: 'staging' },
        created_at: '2026-10-02T10:00:00Z',
        finished_at: '2026-10-02T10:05:00Z',
      }),
      job(901, 'build', 'build', 'success', { environment: null }),
    ],
  })
  const jobs = await forge.listPipelineJobs?.('acme/widget', { ref: 'v1.2.0' })
  expect(jobs?.map((j) => [j.name, j.status, j.manual, j.environment])).toEqual([
    ['build', 'success', false, undefined],
    ['deploy-staging', 'success', true, 'staging'],
    ['deploy-production', 'manual', true, 'production'],
  ])
  expect(jobs?.[1]).toMatchObject({
    pipelineId: 41,
    stage: 'deploy',
    createdAt: '2026-10-02T10:00:00Z',
    finishedAt: '2026-10-02T10:05:00Z',
  })
  expect(calls[0]).toBe('/api/v4/projects/acme%2Fwidget/pipelines/latest?ref=v1.2.0')

  const first = await forge.listPipelineJobs?.('acme/widget', { limit: 1 })
  expect(first?.map((j) => j.name)).toEqual(['build'])
  expect(calls.at(-2)).toBe('/api/v4/projects/acme%2Fwidget/pipelines/latest')
})

test('a ref without pipelines has no jobs', async () => {
  const { forge } = setup({})
  expect(await forge.listPipelineJobs?.('acme/widget', { ref: 'main' })).toEqual([])
})
