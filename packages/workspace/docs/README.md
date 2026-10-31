# @holtkeeper/workspace

Local checkouts of remote repositories for analyzers and the task engine.

```ts
import { checkout } from '@holtkeeper/workspace'

const tree = await checkout({
  cloneUrl: repository.cloneUrl,
  ref: 'v1.4.0', // default: the remote's default branch
  credentials: { username: 'oauth2', password: token },
  cacheDir: '.holtkeeper/cache',
  runner: localRunner,
  signal,
})
// tree.dir, tree.sha, tree.ref
await tree.cleanup()
```

## How it works

- One bare mirror per repository lives in `cacheDir` (`<name>-<hash>.git`, see `mirrorName`). The first call runs `git clone --mirror`, later calls `git fetch --prune --tags`, so only new objects cross the network.
- Each call adds a detached git worktree of the mirror in a fresh temporary directory (`workDir`, default the OS temp dir). Checkouts have full history, every branch and every tag, and are private to the caller: modifying one does not affect others. `cleanup` removes the worktree and its directory and is safe to call twice.
- Calls for the same mirror are serialized in-process and, across processes, by `<mirror>.lock` (created with `O_EXCL`), so `cacheDir` can be one volume shared by several hosts (NFS or another ReadWriteMany volume). The holder refreshes the lock every 30 s; one not refreshed for 5 minutes belongs to a killed process and is taken over. Holding it, git's own leftover `*.lock` files at the top of the mirror and under `refs/` are removed, and `fetch` runs garbage collection in the foreground (`gc.autoDetach=false`) so it finishes under the lock.
- Worktrees are added locked (`--lock`, reason `holtkeeper <host> <time>`): on a shared mirror `git worktree prune` would otherwise drop other hosts' live worktrees, whose directories it cannot see. `cleanup` removes its own with `--force --force`; locks of ours older than a day are lifted so prune drops worktrees of processes that died.
- Credentials never touch disk: they are passed only to the git processes that talk to the remote, through environment variables read by an inline credential helper (`-c credential.helper=...`). They do not appear in argv, the mirror's config or the remote URL. Git never prompts (`GIT_TERMINAL_PROMPT=0`).

## SSH transport and signed commits

```ts
const tree = await checkout({
  cloneUrl: repository.cloneUrl, // https://… becomes git@host:path.git
  ssh: { privateKey, knownHosts }, // from an `ssh` credential of @holtkeeper/ssh-keys
  signing: { privateKey, publicKey, name: 'Holtkeeper Bot', email: 'bot@example.com' },
  cacheDir,
  runner,
})
await Bun.write(join(tree.dir, 'package.json'), updated)
const commit = await tree.commit({ message: 'chore(deps): update x', paths: ['package.json'] })
if (commit) await tree.push({ branch: 'holtkeeper/update/x' })
```

- With `ssh`, every remote git call (clone, fetch, push) runs with `GIT_SSH_COMMAND='ssh -i <key> -o IdentitiesOnly=yes -o UserKnownHostsFile=<known_hosts> -o StrictHostKeyChecking=yes -o BatchMode=yes -F /dev/null'`. The key and `known_hosts` are written to a fresh private temp directory (`0700`, files `0600`, under `workDir` or the OS temp dir) right before the call and removed right after it. Local git calls never see them, and nothing lands in git config. `ssh` takes precedence over `credentials`.
- `sshCloneUrl(url)` turns `https://host/path(.git)` into `git@host:path.git` and keeps SSH URLs as they are. Ports and path prefixes of the HTTPS URL are dropped; pass the SSH URL directly when the forge's SSH endpoint differs. HTTPS and SSH checkouts of the same repository use separate mirrors.
- `commit({ message, paths? })` stages the given paths (all changes when omitted; deletions included) and commits on the detached `HEAD`; it returns `undefined` when nothing is staged. With `signing` it runs `git -c gpg.format=ssh -c user.signingkey=<temp key> -c commit.gpgsign=true` (the key file again lives only for that call) and sets author and committer to `signing.name` / `signing.email`; otherwise `author` or git's own config is used. `checkout` rejects a signing key whose halves do not match.
- `push({ branch })` pushes `HEAD` to `refs/heads/<branch>` with `--force-with-lease` against the commit the mirror last saw there, so it replaces what an earlier run pushed but never a branch someone else moved since the fetch. It skips the push (`pushed: false`) when the branch already holds the same tree.
- These paths are local: with a runner that executes elsewhere (a container), the temp directory must be visible there too, e.g. by putting `workDir` on a shared mount.

## API

- `checkout(options): Promise<GitCheckout>` — `Checkout = { dir, sha, ref, cleanup() }`, plus `commit` and `push` on `GitCheckout`; rejects on unknown refs or git failures without leaving a directory behind. Options: `cloneUrl`, `ref?`, `credentials?`, `ssh?: { privateKey, knownHosts, user? }`, `signing?: { privateKey, publicKey, name, email }`, `author?`, `cacheDir`, `runner`, `signal?`, `workDir?`, `log?`.
- `sshCloneUrl(cloneUrl, user?)`, `gitSshCommand(keyFile, knownHostsFile)` — the URL and `GIT_SSH_COMMAND` used for SSH.
- `mirrorName(cloneUrl)` — stable, readable cache directory name; credentials in the URL do not change it.
- `GitCredentials` — `{ username, password }`, what `ForgeDefinition.gitCredentials?()` returns.
- `listMirrors(cacheDir)` — `{ name, bytes, lastUsedAt }[]`, largest first; `lastUsedAt` is the mirror's `FETCH_HEAD` (or `HEAD`) mtime.
- `pruneMirrors(cacheDir, { unusedForDays })` — deletes mirrors not fetched for that many days (`0`: all); do not run it while jobs use the cache.
- `mirrorStorage(cacheDir)` — the cache as a `StorageProvider` (`@holtkeeper/artifacts` shape) for the server's storage overview; `clear(days?)` prunes.
- `directorySize(path)` — bytes of a directory tree.

All git calls go through a `CommandRunner`; `test/checkout.test.ts` runs real git against `file://` repositories in temp directories, and `test/ssh.test.ts` clones and pushes through a fake `ssh` on `PATH` that checks the arguments and key file modes and serves a local repository with `git-upload-pack` / `git-receive-pack`, then verifies the commit signature with `ssh-keygen -Y verify`.
