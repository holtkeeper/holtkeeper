# @holtkeeper/ssh-keys

SSH keys for the bot: generated locally, registered through the forge API, stored as sealed credentials, used for git over SSH and for signing commits.

## Generation

```ts
import { fingerprint, generateKeyPair, parsePrivateKey, parsePublicKey } from '@holtkeeper/ssh-keys'

const pair = generateKeyPair({ type: 'ed25519', comment: 'holtkeeper@gitlab.example.com' })
pair.publicKey // 'ssh-ed25519 AAAAC3Nza… holtkeeper@gitlab.example.com'
pair.privateKey // '-----BEGIN OPENSSH PRIVATE KEY-----\n…'
pair.fingerprint // 'SHA256:…', what `ssh-keygen -lf` prints
```

- Keys come from `node:crypto` (`generateKeyPairSync('ed25519')`) and are encoded by this package: the public key as one `authorized_keys` line, the private key as an unencrypted `openssh-key-v1` file (cipher and KDF `none`, random check ints, `1, 2, 3…` padding to 8 bytes, base64 wrapped at 70 columns). Tests round-trip them through the real `ssh-keygen -y` and `ssh-keygen -lf`.
- `parsePublicKey(line)` → `{ type, blob, comment, fingerprint }` for any algorithm; it rejects a line whose type disagrees with the blob.
- `parsePrivateKey(text)` reads unencrypted Ed25519 OpenSSH keys (also ones made by `ssh-keygen`) and returns the public half, comment and fingerprint. It checks the check ints, the padding and that the private half really derives the public one. Encrypted keys are refused.
- `fingerprint(publicKey)` is `SHA256:` plus unpadded base64 of the blob's SHA-256.

## Known hosts

```ts
const { knownHosts } = await pinHostKeys({
  host: 'gitlab.example.com',
  runner,
  fingerprints: ['SHA256:…'], // from the forge's documented host keys
})
```

`scanHostKeys` runs `ssh-keyscan -T 10 -t ed25519,ecdsa,rsa [-p port] host` through a `CommandRunner` and parses the answer. That answer is unauthenticated, so `pinHostKeys` keeps only the keys whose fingerprints you expect and throws `HostKeyMismatchError` when none match; without `fingerprints` it trusts whatever the host offers (trust on first use). `parseKnownHosts` / `formatKnownHosts` read and write `known_hosts` lines; `knownHostsName(host, port)` gives `[host]:port` for non-standard ports.

## Registration

Forges register keys through the optional `GitForge` methods of `@holtkeeper/forge`:

```ts
const { id } = await forge.registerSshKey!({
  title: 'holtkeeper bot',
  publicKey: pair.publicKey,
  usage: 'auth_and_signing', // 'auth' | 'signing' | 'auth_and_signing'
  expiresAt: '2027-04-01T00:00:00Z',
  scope: { kind: 'user' }, // or { kind: 'deploy', repo: 'games/slots', canPush: true }
})
await forge.enableDeployKey?.(id, { kind: 'deploy', repo: 'games/other', canPush: false })
```

`user` keys belong to the account behind the forge token (the bot user) and can authenticate and sign. Deploy keys belong to repositories and only authenticate; GitLab rejects any usage but `auth` for them. `listSshKeys(scope)` and `removeSshKey(id, scope)` complete the set.

## Credentials

A credential of kind `ssh` keeps the private key as its sealed secret and everything else in `options`:

```ts
const input = createSshCredentialInput({
  name: 'bot ssh key',
  url: 'https://gitlab.example.com',
  scope: { kind: 'global' },
  keyPair: pair,
  usage: 'auth_and_signing',
  registered: [{ forge: 'gitlab', scope: { kind: 'user' }, id }],
  knownHosts,
})
await credentials.create(input, actor)
```

`options` = `{ publicKey, fingerprint, usage, registered: { forge, scope, id }[], knownHosts?, identity?: { name, email } }` (`sshCredentialOptionsSchema`); `identity` is the author of commits signed with the key. Pass `validateSshCredentialOptions` as the credential service's `validateOptions` (combine it with validators of other kinds); it also checks that `fingerprint` matches `publicKey`. `readSshCredential(secret, options)` turns a revealed credential back into `{ privateKey, publicKey, … }` and refuses a secret that does not belong to the public key.

## Rotation

`TokenRotator` from `@holtkeeper/credentials` swaps one token string for another and never sees `options`, so SSH keys rotate through a separate flow, `rotateSshKey`:

```ts
const result = await rotateSshKey({
  current: options,
  forge: (id) => config.forges[id].create(),
  title: 'holtkeeper bot',
  expiresAt,
  activate: ({ secret, options }) => credentials.update(credentialId, { secret, options }, actor),
})
```

1. Generates a new Ed25519 key.
2. Registers it in every place in `current.registered` (same forge, scope and usage).
3. Calls `activate` with the new secret and options — from here on git uses the new key.
4. Removes the old registrations. Failures here are reported in `failedRemovals` instead of rejecting, because the new key already works.

When a registration or `activate` fails, the new registrations are removed again and the call rejects; the old key keeps working. Run it from a schedule next to `startRotationSchedule` (for example when `expiresAt` is close).

## Using the key

`@holtkeeper/workspace` takes the key per checkout — `checkout({ ssh: { privateKey, knownHosts }, signing: { privateKey, publicKey, name, email } })` — and `@holtkeeper/propagate`'s `publishChanges({ mode: 'git', git: checkout })` commits and pushes with it. Commits made through the GitLab Commits API cannot carry our signature (GitLab may sign web and API commits with its own key, depending on instance settings), so signed commits need `mode: 'git'`.

## Security notes

- Private keys are never encrypted with a passphrase: the credential vault seals them at rest. Do not write them anywhere else.
- Workspace writes key material only into a fresh `0700` temp directory as `0600` files, for the duration of one git call, and removes it afterwards. Keys are never put into git config, argv or remote URLs.
- Host keys are pinned: git runs with `StrictHostKeyChecking=yes` and only the pinned `known_hosts`, so an unknown or changed host key fails the call.
- Give deploy keys `canPush` only where pushing is needed; prefer a user key on a dedicated bot account with the least repository access.
- For verified signatures, register the key with `signing` or `auth_and_signing` usage on the account whose (verified) email is used as the commit author.
