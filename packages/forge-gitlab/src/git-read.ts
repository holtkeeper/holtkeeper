import type { PackageRegistryLocation } from './packages.ts'

/** Requests a proxy may add read credentials to, with the methods it may add them for. */
export interface GitReadLocation extends PackageRegistryLocation {
  methods: string[]
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const segment = '(?!(?:\\.\\.?|-)(?:/|\\?|$))[^/?#%]+'

/**
 * The read-only git smart-HTTP and `go get` discovery endpoints of the GitLab at `url`, for
 * proxies that add a token there so `go mod download` and `git clone` of private modules work:
 *
 * - `GET`/`HEAD` of `<project>?go-get=1` and `<project>[.git]/info/refs?service=git-upload-pack`;
 * - `POST` of `<project>[.git]/git-upload-pack`.
 *
 * Never `git-receive-pack`, never `/api/`, never `..`, `-` (GitLab's web routes) or
 * percent-encoded segments, and only paths under the instance's sub-path, so the token can fetch
 * but never push.
 */
export function gitlabGitRead(url: string): GitReadLocation[] {
  const parsed = new URL(url)
  const base = escape(parsed.pathname.replace(/\/+$/, ''))
  const project = `${base}/(?!api/)${segment}(?:/${segment})+`
  return [
    {
      host: parsed.hostname,
      paths: [`^${project}\\?go-get=1$`, `^${project}/info/refs\\?service=git-upload-pack$`],
      methods: ['GET', 'HEAD'],
    },
    { host: parsed.hostname, paths: [`^${project}/git-upload-pack$`], methods: ['POST'] },
  ]
}

/** `Authorization` value GitLab accepts for git over HTTP and `go get` with an API token. */
export const gitlabGitAuthorization = (token: string) =>
  `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`
