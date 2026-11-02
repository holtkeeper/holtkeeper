import type {
  BranchRecord,
  GitForge,
  MergeRequestRecord,
  RepoRef,
  TagRecord,
} from '@holtkeeper/forge'

import type { FlowDetection } from './types.ts'

const sourceNames = ['development', 'develop', 'dev']

const CALVER = /^\d{4}\.\d{1,2}\.\d+$/u
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

export interface DetectionInput {
  defaultBranch: string
  branches: readonly Pick<BranchRecord, 'name'>[]
  tags: readonly Pick<TagRecord, 'name'>[]
  merged: readonly Pick<MergeRequestRecord, 'sourceBranch' | 'targetBranch'>[]
  /** Paths at the repository root. */
  files: readonly string[]
}

/**
 * Suggests a release flow from what a repository already does: a release tool's files mean
 * `external`, merge requests from a long-lived development branch into another branch mean the
 * merge request flow into the branch it is merged into most (`flow.target` when that is not the
 * default branch, which may be the development branch itself), otherwise trunk. The tag format and scheme follow the existing tags.
 * Pure; `reasons` say what the guess rests on.
 */
export function detectFlow(input: DetectionInput): FlowDetection {
  const reasons: string[] = []
  const settings: Record<string, unknown> = {}
  let preset = 'trunk'

  const packageTags = input.tags.filter((tag) => /^(?:@[^/]+\/)?[\w.-]+@\d/u.test(tag.name))
  if (input.files.includes('.changeset') || packageTags.length > input.tags.length / 2) {
    reasons.push(
      input.files.includes('.changeset')
        ? 'a .changeset folder: changesets releases it'
        : 'tags name packages (name@version): a release tool tags it',
    )
    return { preset: 'external', settings: { flow: { mode: 'external' } }, reasons }
  }

  const branches = new Set(input.branches.map((branch) => branch.name))
  const pairs = new Map<string, { source: string; target: string; merges: number }>()
  for (const mr of input.merged) {
    if (
      !sourceNames.includes(mr.sourceBranch) ||
      sourceNames.includes(mr.targetBranch) ||
      !branches.has(mr.sourceBranch) ||
      !branches.has(mr.targetBranch)
    )
      continue
    const key = `${mr.sourceBranch}\0${mr.targetBranch}`
    const pair = pairs.get(key) ?? { source: mr.sourceBranch, target: mr.targetBranch, merges: 0 }
    pair.merges += 1
    pairs.set(key, pair)
  }
  const release = [...pairs.values()].toSorted((a, b) => b.merges - a.merges)[0]
  const source = release?.source ?? sourceNames.find((name) => branches.has(name))
  if (release) {
    preset = 'merge-request-deferred-version'
    settings['flow'] = {
      mode: 'merge-request',
      source: release.source,
      ...(release.target === input.defaultBranch ? {} : { target: release.target }),
    }
    reasons.push(`${release.merges} merge request(s) from ${release.source} into ${release.target}`)
  } else {
    settings['flow'] = { mode: 'trunk' }
    reasons.push(
      source
        ? `${source} exists but is not merged into another branch through merge requests`
        : `no long-lived development branch next to ${input.defaultBranch}`,
    )
  }

  const names = input.tags.map((tag) => tag.name)
  const prefixed = names.filter((name) => /^v\d/u.test(name)).length
  const bare = names.filter((name) => /^\d/u.test(name)).length
  const prefix = prefixed >= bare ? 'v' : ''
  const versions = names
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
  const calver = versions.filter((version) => CALVER.test(version)).length
  const semver = versions.filter((version) => SEMVER.test(version)).length - calver
  if (calver > semver && calver > 0) {
    settings['version'] = { scheme: 'calver', tagFormat: `${prefix}{version}` }
    reasons.push(`${calver} calendar version tag(s)`)
  } else {
    settings['version'] = { scheme: 'semver', tagFormat: `${prefix}{version}` }
    reasons.push(
      semver > 0
        ? `${semver} semantic version tag(s) ${prefix ? 'with' : 'without'} a v prefix`
        : 'no version tags yet: semantic versions with a v prefix',
    )
  }
  return { preset, settings, reasons }
}

/** Reads what `detectFlow` needs from the forge; reads a forge lacks count as empty. */
export async function detectRepositoryFlow(forge: GitForge, repo: RepoRef): Promise<FlowDetection> {
  const repository = await forge.getRepository(repo.path)
  const [branches, tags, merged, files] = await Promise.all([
    forge.listBranches?.(repo.path).catch(() => []) ?? [],
    forge.listTags?.(repo.path, { limit: 100 }).catch(() => []) ?? [],
    forge.listMergeRequests?.(repo.path, { state: 'merged', limit: 100 }).catch(() => []) ?? [],
    forge.listFiles?.(repo.path).catch(() => []) ?? [],
  ])
  return detectFlow({
    defaultBranch: repository.defaultBranch,
    branches,
    tags,
    merged,
    files: files.map((entry) => entry.path),
  })
}
