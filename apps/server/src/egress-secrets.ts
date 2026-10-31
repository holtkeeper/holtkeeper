import type { CredentialView, EgressRule } from '@holtkeeper/api'
import { z } from 'zod'

/** Credential kind whose secret the egress proxy swaps in for a placeholder. */
export const EGRESS_SECRET_KIND = 'egress-secret'

const host = z
  .string()
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i,
    'expected a host name or *.example.com',
  )

/**
 * Options of an `egress-secret` credential. The credential URL's host is always a target; requests
 * to it over plain HTTP are changed only when that URL is `http:`.
 */
const egressSecretOptionsSchema = z.object({
  /** What jobs hold instead of the secret; not secret itself. */
  placeholder: z
    .string()
    .regex(/^[A-Za-z0-9._~-]{16,128}$/, 'expected 16 to 128 letters, digits, ., _, ~ or -'),
  /** More hosts the secret may be sent to. */
  hosts: z.array(host).optional(),
  /** Regular expressions searched in the path with its query; none: every path. */
  paths: z
    .array(
      z.string().refine((value) => {
        try {
          return Boolean(RegExp(value))
        } catch {
          return false
        }
      }, 'expected a regular expression'),
    )
    .optional(),
  /** Default: any method. */
  methods: z.array(z.string().regex(/^[A-Za-z]+$/, 'expected an HTTP method')).optional(),
  /** Where the placeholder is replaced; default headers only. */
  in: z
    .array(z.enum(['headers', 'url', 'body']))
    .min(1)
    .optional(),
})

/**
 * A `CredentialOptionsValidator` for `@holtkeeper/credentials`: checks `egress-secret` options and
 * returns `field: message` problems; `undefined` for other kinds.
 */
export function validateEgressSecretOptions(
  kind: string,
  options: Record<string, unknown> | undefined,
): string[] | undefined {
  if (kind !== EGRESS_SECRET_KIND) return undefined
  const parsed = egressSecretOptionsSchema.safeParse(options ?? {})
  if (parsed.success) return []
  return parsed.error.issues.map(
    (issue) => `options.${issue.path.join('.') || '(root)'}: ${issue.message}`,
  )
}

/**
 * The egress rules of one `egress-secret` credential and its plaintext secret: one per host,
 * replacing the placeholder with the secret. Throws when the options are invalid.
 */
export function egressSecretRules(
  credential: Pick<CredentialView, 'url' | 'options'>,
  secret: string,
): EgressRule[] {
  const options = egressSecretOptionsSchema.parse(credential.options ?? {})
  const url = new URL(credential.url)
  const hosts = [...new Set([url.hostname, ...(options.hosts ?? [])].map((h) => h.toLowerCase()))]
  return hosts.map((target) => ({
    host: target,
    ...(options.paths?.length && { paths: options.paths }),
    methods: options.methods?.length ? options.methods.map((m) => m.toUpperCase()) : ['*'],
    replace: { [options.placeholder]: secret },
    in: options.in ?? ['headers'],
    ...(url.protocol === 'http:' && { insecure: true }),
  }))
}
