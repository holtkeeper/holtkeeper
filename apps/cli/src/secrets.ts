import { fingerprintPattern, matchKvSecrets, secretFingerprint } from '@holtkeeper/secret-reports'

import { UsageError } from './serve.ts'

/** Raw `secrets` flags as `parseArgs` returns them. */
export interface SecretsFlags {
  address?: string | undefined
  mount?: string | undefined
  prefix?: string | undefined
  namespace?: string | undefined
  json?: boolean | undefined
}

/** What `secrets` reads besides its flags; tests replace them. */
export interface SecretsIo {
  /** Everything on standard input. */
  stdin: () => Promise<string>
  env: Record<string, string | undefined>
  fetch?: typeof fetch
}

const defaultIo: SecretsIo = {
  stdin: async () => Bun.stdin.text(),
  env: process.env,
}

/**
 * `holtkeeper secrets fingerprint` prints the fingerprint of the value on standard input (one
 * trailing newline dropped), as secret reports carry it. `holtkeeper secrets match <fingerprint...>
 * --address <url> --mount <mount>` walks an OpenBao or Vault KV v2 engine with the token from
 * `BAO_TOKEN` or `VAULT_TOKEN` and prints where each fingerprint's value lives. Values never leave
 * the process. Resolves with the exit code: 0 when something matched (or for `fingerprint`), 1
 * when nothing did.
 */
export async function secretsCommand(
  args: readonly string[],
  flags: SecretsFlags,
  out: (line: string) => void,
  io: SecretsIo = defaultIo,
): Promise<number> {
  const [action, ...rest] = args
  if (action === 'fingerprint') {
    const value = (await io.stdin()).replace(/\r?\n$/, '')
    if (!value)
      throw new UsageError(
        'secrets fingerprint: pipe the value in, e.g. printf %s "$KEY" | holtkeeper secrets fingerprint',
      )
    out(await secretFingerprint(value))
    return 0
  }
  if (action !== 'match')
    throw new UsageError('secrets: expected fingerprint or match <fingerprint...>')

  const fingerprints = rest.map((value) => value.trim().toLowerCase())
  if (!fingerprints.length || fingerprints.some((value) => !fingerprintPattern.test(value)))
    throw new UsageError('secrets match: give one or more fingerprints of 16 hex characters')
  const address = flags.address ?? io.env.BAO_ADDR ?? io.env.VAULT_ADDR
  if (!address)
    throw new UsageError('secrets match: --address (or BAO_ADDR, VAULT_ADDR) is required')
  if (!flags.mount) throw new UsageError('secrets match: --mount is required, e.g. --mount secret')
  const token = io.env.BAO_TOKEN ?? io.env.VAULT_TOKEN
  if (!token) throw new UsageError('secrets match: set BAO_TOKEN or VAULT_TOKEN')

  const matches = await matchKvSecrets({
    address,
    token,
    mount: flags.mount,
    fingerprints,
    ...(flags.prefix && { prefix: flags.prefix }),
    ...(flags.namespace && { namespace: flags.namespace }),
    ...(io.fetch && { fetch: io.fetch }),
  })
  if (flags.json) out(JSON.stringify(matches, null, 2))
  else if (!matches.length) out('No secret has these fingerprints.')
  else
    for (const match of matches)
      out(
        [match.fingerprint, `${flags.mount}/${match.path}`, match.field, match.version ?? '-'].join(
          '\t',
        ),
      )
  return matches.length ? 0 : 1
}
