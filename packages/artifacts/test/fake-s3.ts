const xml = (body: string, status = 200) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status,
    headers: { 'content-type': 'application/xml' },
  })

const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const notFound = () =>
  xml(
    '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>',
    404,
  )

/** The few S3 calls `s3ArtifactStore` makes, path-style, without auth checks. */
export function startFakeS3(bucket: string) {
  const objects = new Map<string, { data: Uint8Array; type: string; modified: Date }>()
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}${url.search}`)
      const [, name, ...rest] = url.pathname.split('/')
      if (name !== bucket) return xml('<Error><Code>NoSuchBucket</Code></Error>', 404)
      const key = decodeURIComponent(rest.join('/'))

      if (!key && request.method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? ''
        const max = Number(url.searchParams.get('max-keys') ?? 1000)
        const start = Number(url.searchParams.get('continuation-token') ?? 0)
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).toSorted()
        const page = keys.slice(start, start + max)
        const truncated = start + max < keys.length
        return xml(
          `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${
            truncated ? `<NextContinuationToken>${start + max}</NextContinuationToken>` : ''
          }${page
            .map((k) => {
              const object = objects.get(k)
              return `<Contents><Key>${escape(k)}</Key><LastModified>${object?.modified.toISOString()}</LastModified><ETag>"x"</ETag><Size>${object?.data.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`
            })
            .join('')}</ListBucketResult>`,
        )
      }

      const object = objects.get(key)
      switch (request.method) {
        case 'PUT': {
          objects.set(key, {
            data: new Uint8Array(await request.arrayBuffer()),
            type: request.headers.get('content-type') ?? 'application/octet-stream',
            modified: new Date(),
          })
          return new Response(null, { status: 200, headers: { etag: '"x"' } })
        }
        case 'GET':
        case 'HEAD': {
          if (!object)
            return request.method === 'HEAD' ? new Response(null, { status: 404 }) : notFound()
          const headers = {
            'content-type': object.type,
            'content-length': String(object.data.byteLength),
            'last-modified': object.modified.toUTCString(),
            etag: '"x"',
          }
          return new Response(request.method === 'HEAD' ? null : object.data, { headers })
        }
        case 'DELETE': {
          objects.delete(key)
          return new Response(null, { status: 204 })
        }
        default:
          return new Response(null, { status: 405 })
      }
    },
  })

  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    objects,
    requests,
    stop: () => server.stop(true),
  }
}
