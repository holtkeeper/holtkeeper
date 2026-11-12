import { describe, expect, test } from 'bun:test'

import { gitlab, GitLabApiError } from '../src/index.ts'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function setup(answer: () => Response = () => Response.json({ id: 7, username: 'widget-bot' })) {
  const calls: { url: string; init: RequestInit }[] = []
  const forge = gitlab({
    url: 'https://forge.test/',
    token: 'glpat-avatar',
    fetch: async (url, init) => {
      calls.push({ url, init })
      return answer()
    },
  }).create()
  return { forge, calls }
}

describe('setCurrentUserAvatar', () => {
  test('sends the image as the multipart avatar field of PUT /user/avatar', async () => {
    const { forge, calls } = setup()
    await forge.setCurrentUserAvatar!({
      bytes: png,
      filename: 'face.png',
      contentType: 'image/png',
    })
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe('https://forge.test/api/v4/user/avatar')
    expect(init.method).toBe('PUT')
    const headers = init.headers as Record<string, string>
    expect(headers['PRIVATE-TOKEN']).toBe('glpat-avatar')
    expect(headers['Content-Type']).toBeUndefined()
    expect(init.body).toBeInstanceOf(FormData)
    const file = (init.body as FormData).get('avatar')
    expect(file).toBeInstanceOf(File)
    expect((file as File).name).toBe('face.png')
    expect((file as File).type).toBe('image/png')
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(png)
  })

  test('surfaces GitLab rejections without the token', async () => {
    const { forge } = setup(() =>
      Response.json(
        { message: { avatar: ['is too big (should be at most 200 KiB)'] } },
        { status: 400 },
      ),
    )
    const error = await forge.setCurrentUserAvatar!({
      bytes: png,
      filename: 'face.png',
      contentType: 'image/png',
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitLabApiError)
    expect(String(error)).toContain('too big')
    expect(String(error)).not.toContain('glpat-avatar')
  })
})
