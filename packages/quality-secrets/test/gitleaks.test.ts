import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localRunner } from '@holtkeeper/exec'

import { secretsCheck } from '../src/index.ts'

// Built at runtime so scanners do not flag this file. Both follow gitleaks' own test patterns.
const awsKey = ['AKIA', 'LALEMEL33243OLIA'].join('')
const githubToken = ['ghp', '8sjXq2LmN4pR7tV1wZ9yB3cD6fH0kJ5aQeUo'].join('_')

async function git(dir: string, ...args: string[]) {
  const result = await localRunner.run(['git', ...args], {
    cwd: dir,
    env: { GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr)
}

test.skipIf(!Bun.which('gitleaks') || !Bun.which('git'))(
  'finds fake keys with the real gitleaks',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quality-secrets-gitleaks-'))
    try {
      await git(dir, 'init', '-q')
      await git(dir, 'config', 'user.email', 'dev@example.com')
      await git(dir, 'config', 'user.name', 'Dev')
      await mkdir(join(dir, 'src'))
      await Bun.write(
        join(dir, 'src/config.js'),
        `const region = 'us-east-1'\nconst key = '${awsKey}'\n`,
      )
      await Bun.write(join(dir, '.env'), `GITHUB_TOKEN=${githubToken}\n`)
      await git(dir, 'add', '-A')
      await git(dir, 'commit', '-qm', 'add config')
      await git(dir, 'rm', '-q', '.env')
      await git(dir, 'commit', '-qm', 'remove token')

      const check = secretsCheck({ history: true })
      expect(await check.detect(dir)).toBe(true)
      const result = await check.run({ dir, runner: localRunner })

      expect(result.version).toMatch(/^gitleaks \d+\.\d+\.\d+/)
      const issues = result.issues ?? []
      expect(
        issues
          .map(
            (issue) =>
              `${issue.file}:${issue.range?.start.line}:${issue.range?.start.column} ${issue.rule}`,
          )
          .toSorted(),
      ).toEqual(['.env:1:14 github-pat', 'src/config.js:2:14 aws-access-token'])
      expect(JSON.stringify(issues)).not.toContain(awsKey)
      expect(JSON.stringify(issues)).not.toContain(githubToken)
      expect(issues.find((issue) => issue.file === '.env')?.help).toContain('by Dev')

      await Bun.write(
        join(dir, '.gitleaks.toml'),
        '[extend]\nuseDefault = true\n[allowlist]\npaths = ["src/config.js"]\n',
      )
      const configured = await secretsCheck().run({ dir, runner: localRunner })
      expect(configured.issues).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
