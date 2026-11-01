import { forgeLinks } from '@holtkeeper/changelog'
import { type HoltkeeperConfig, resolveRepo } from '@holtkeeper/core'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import { groupRepositories } from '@holtkeeper/jobs'
import {
  type Acceptance,
  type ReleaseFacts,
  type ReleasePlan,
  type ReleaseSettings,
  acceptanceSchema,
  boardRow,
  collectFacts,
  createVersion,
  planRelease,
  proposeRelease,
  readDeployState,
  readStored,
  releasePresets,
  releaseSettingsKey,
  releaseSettingsSchema,
  startDeploy,
} from '@holtkeeper/release'
import { resolveSetting } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'

import { UsageError } from './audit.ts'

/** Raw `release` flags as `parseArgs` returns them. */
export interface ReleaseFlags {
  repo?: string | undefined
  group?: string | undefined
  step?: string | undefined
  version?: string | undefined
  tag?: string | undefined
  env?: string | undefined
  preset?: string | undefined
  settings?: string | undefined
  note?: string | undefined
  force?: boolean | undefined
  redeploy?: boolean | undefined
  'dry-run'?: boolean | undefined
  json?: boolean | undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `base` with `patch` laid over it, objects merged field by field. */
function merge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return patch === undefined ? base : patch
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) result[key] = merge(base[key], value)
  return result
}

const parseRepoFlag = (value: string | undefined): RepoRef | undefined => {
  if (!value) return undefined
  const separator = value.indexOf(':')
  if (separator < 1) throw new UsageError('--repo expects <forge>:<path>, e.g. work:games/app')
  return { forge: value.slice(0, separator), path: value.slice(separator + 1) }
}

const acceptanceKey = (repo: RepoRef) => `release:acceptance:${repo.forge}:${repo.path}`

const line = (...cells: (string | number | undefined)[]) =>
  cells.map((cell) => String(cell ?? '-')).join('\t')

function describePlan(plan: ReleasePlan): string {
  const gates = plan.gates.map((gate) => `  ${gate.ok ? 'ok  ' : 'FAIL'} ${gate.message}`)
  return [
    `${plan.step === 'propose' ? 'Merge request' : 'Release'}: ${plan.title}`,
    `Range: ${plan.range.fromLabel ?? 'start'}..${plan.range.toLabel} (${plan.commitCount} commits${plan.capped ? ', capped' : ''})`,
    `Version: ${plan.current?.version ?? 'none'} -> ${plan.version ?? 'none'} (suggested ${plan.suggested.version ?? 'none'}: ${plan.suggested.reasons.map((reason) => `${reason.bump} for ${reason.because}`).join(', ') || 'nothing to release'})`,
    'Gates:',
    ...gates,
    '',
    plan.body,
  ].join('\n')
}

/**
 * `holtkeeper release <status | plan | propose | accept | version | deploy>`: the release
 * assistant from the command line, with the config's forges. Settings are the `releases` setting
 * from the config's store when it has a server section, then `--preset` ids and the JSON file of
 * `--settings` laid over it. Acceptances go to the same store, so `release accept` from a CI job
 * or a script accepts like the panel does.
 */
export async function releaseCommand(
  config: HoltkeeperConfig,
  args: string[],
  flags: ReleaseFlags,
  out: (line: string) => void,
  now: () => Date = () => new Date(),
): Promise<number> {
  const [action] = args
  const store: Store | undefined = config.server?.store
  try {
    const presets = (flags.preset ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => {
        const preset = releasePresets.find((candidate) => candidate.id === id)
        if (!preset)
          throw new UsageError(
            `unknown preset ${id}; one of ${releasePresets.map((p) => p.id).join(', ')}`,
          )
        return preset.value
      })
    const file: unknown = flags.settings ? await Bun.file(flags.settings).json() : undefined

    const settingsOf = async (repo: RepoRef): Promise<ReleaseSettings> => {
      const entries = store ? await store.settings.list(releaseSettingsKey) : []
      const stored = resolveSetting(entries, releaseSettingsKey, {
        ...repo,
        groups: resolveRepo(config, repo).groups,
      })?.value
      const value = [...presets, file].reduce<unknown>(
        (acc, patch) => merge(acc, patch),
        stored ?? {},
      )
      const parsed = releaseSettingsSchema.safeParse(value)
      if (!parsed.success) throw new UsageError(`invalid release settings: ${parsed.error.message}`)
      return parsed.data
    }

    const forgeOf = (repo: RepoRef): GitForge => {
      const definition = config.forges[repo.forge]
      if (!definition) throw new UsageError(`forge ${repo.forge} is not configured`)
      return definition.create()
    }

    const load = async (repo: RepoRef) => {
      const settings = await settingsOf(repo)
      const forge = forgeOf(repo)
      const recorded = readStored(acceptanceSchema, await store?.kv?.get(acceptanceKey(repo)))
      const facts = await collectFacts({ forge, repo, settings, ...(recorded ? { recorded } : {}) })
      return { settings, forge, facts }
    }

    const plan = (
      step: 'propose' | 'version',
      {
        settings,
        forge,
        facts,
      }: { settings: ReleaseSettings; forge: GitForge; facts: ReleaseFacts },
    ) =>
      planRelease({
        step,
        facts,
        settings,
        edits: flags.version ? { version: flags.version } : {},
        links: forgeLinks({
          kind: forge.kind === 'github' ? 'github' : 'gitlab',
          webUrl: facts.webUrl,
          ...(settings.changelog.ticketUrl ? { ticketUrl: settings.changelog.ticketUrl } : {}),
        }),
        now: now(),
      })

    const requireRepo = () => {
      const repo = parseRepoFlag(flags.repo)
      if (!repo) throw new UsageError(`release ${action} needs --repo <forge>:<path>`)
      return repo
    }
    const dryRun = flags['dry-run'] ?? config.dryRun ?? false
    const print = (value: unknown, text: string) =>
      out(flags.json ? JSON.stringify(value, null, 2) : text)

    switch (action) {
      case 'status': {
        const single = parseRepoFlag(flags.repo)
        const repos = single
          ? [single]
          : await (async () => {
              const resolve = groupRepositories(config)
              const names = flags.group ? [flags.group] : Object.keys(config.groups)
              const all: RepoRef[] = []
              for (const name of names)
                // oxlint-disable-next-line no-await-in-loop -- groups one after another keep forge limits
                all.push(...(await resolve(name)))
              return all
            })()
        const rows = []
        for (const repo of repos) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- one repository at a time keeps forge limits
            const loaded = await load(repo)
            const deploy =
              loaded.facts.latest && loaded.settings.deploy.environments.length
                ? // oxlint-disable-next-line no-await-in-loop -- same
                  await readDeployState(
                    loaded.forge,
                    repo,
                    loaded.settings,
                    loaded.facts.latest.tag,
                  )
                : undefined
            rows.push(boardRow(loaded.settings, loaded.facts, now(), deploy))
          } catch (error) {
            rows.push({ repo, error: error instanceof Error ? error.message : String(error) })
          }
        }
        print(
          rows,
          rows
            .map((row) =>
              'error' in row && !('stage' in row)
                ? line(row.repo.path, 'error', row.error)
                : 'stage' in row
                  ? line(
                      row.repo.path,
                      row.stage,
                      `${row.latest?.tag ?? 'none'} -> ${row.next ?? 'none'}`,
                      `ahead ${row.ahead}${row.aheadCapped ? '+' : ''}`,
                      `unreleased ${row.unreleased}${row.unreleasedCapped ? '+' : ''}`,
                      row.request ? `!${row.request.id}` : undefined,
                      row.acceptance ? `accepted by ${row.acceptance.by}` : undefined,
                      row.deploy?.environments.map((env) => `${env.name}:${env.status}`).join(' '),
                    )
                  : '',
            )
            .join('\n'),
        )
        return 0
      }
      case 'plan': {
        const loaded = await load(requireRepo())
        const step =
          flags.step === 'propose' || flags.step === 'version'
            ? flags.step
            : loaded.facts.unreleased.length || loaded.settings.flow.mode !== 'merge-request'
              ? 'version'
              : 'propose'
        const result = plan(step, loaded)
        print(result, describePlan(result))
        return result.gates.every((gate) => gate.ok) ? 0 : 2
      }
      case 'propose': {
        const repo = requireRepo()
        const loaded = await load(repo)
        const result = await proposeRelease(
          { forge: loaded.forge, repo, settings: loaded.settings, now: now(), dryRun },
          loaded.facts,
          plan('propose', loaded),
          { force: flags.force ?? false },
        )
        print(
          result,
          `${result.dryRun ? 'would ' : ''}${result.created ? 'open' : 'update'}: ${result.request.title} ${result.request.webUrl}`.trim(),
        )
        return 0
      }
      case 'accept': {
        const repo = requireRepo()
        if (!store?.kv)
          throw new UsageError('release accept needs a config whose server store keeps state')
        const { facts } = await load(repo)
        const acceptance: Acceptance = {
          sha: facts.target.sha,
          by: 'cli',
          at: now().toISOString(),
          via: 'manual',
          ...(flags.note ? { note: flags.note } : {}),
        }
        if (!dryRun) {
          await store.kv.set(acceptanceKey(repo), acceptance)
          await store.activity.append({
            at: acceptance.at,
            actor: 'cli',
            action: 'release.accepted',
            subject: `${repo.forge}:${repo.path}`,
            ...(flags.note ? { details: { detail: flags.note } } : {}),
          })
        }
        print(
          acceptance,
          `${dryRun ? 'would accept' : 'accepted'} ${facts.target.name} at ${facts.target.sha.slice(0, 8)}`,
        )
        return 0
      }
      case 'version': {
        const repo = requireRepo()
        const loaded = await load(repo)
        const result = await createVersion(
          { forge: loaded.forge, repo, settings: loaded.settings, now: now(), dryRun },
          loaded.facts,
          plan('version', loaded),
          { force: flags.force ?? false },
        )
        if (!dryRun) await store?.kv?.delete(acceptanceKey(repo))
        print(
          result,
          `${result.dryRun ? 'would tag' : 'tagged'} ${result.tag} at ${result.sha.slice(0, 8)}${result.release ? ` ${result.release.webUrl}` : ''}`,
        )
        return 0
      }
      case 'deploy': {
        const repo = requireRepo()
        if (!flags.env) throw new UsageError('release deploy needs --env <environment>')
        const settings = await settingsOf(repo)
        const forge = forgeOf(repo)
        const tag = flags.tag ?? (await collectFacts({ forge, repo, settings })).latest?.tag
        if (!tag) throw new UsageError('no version to deploy; pass --tag')
        if (dryRun) {
          out(`would deploy ${tag} to ${flags.env}`)
          return 0
        }
        const { job } = await startDeploy({
          forge,
          repo,
          settings,
          tag,
          environment: flags.env,
          redeploy: flags.redeploy ?? false,
          force: flags.force ?? false,
        })
        print(job, `started ${job.name} for ${tag}: ${job.webUrl}`)
        return 0
      }
      default:
        throw new UsageError('release expects status, plan, propose, accept, version or deploy')
    }
  } catch (error) {
    if (error instanceof UsageError) throw error
    if (
      error instanceof Error &&
      ['GateError', 'DeployError', 'UnsupportedForgeError'].includes(error.name)
    )
      throw new UsageError(error.message)
    throw error
  } finally {
    await store?.close()
  }
}
