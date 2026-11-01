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
 * `external`, merge requests from a long-lived development branch into the default branch mean
 * the merge request flow, otherwise trunk. The tag format and scheme follow the existing tags.
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

  const source = sourceNames.find(
    (name) => name !== input.defaultBranch && input.branches.some((b) => b.name === name),
  )
  const merges = source
    ? input.merged.filter(
        (mr) => mr.sourceBranch === source && mr.targetBranch === input.defaultBranch,
      ).length
    : 0
  if (source && merges > 0) {
    preset = 'merge-request-deferred-version'
    settings['flow'] = { mode: 'merge-request', source }
    reasons.push(`${merges} merge request(s) from ${source} into ${input.defaultBranch}`)
  } else {
    settings['flow'] = { mode: 'trunk' }
    reasons.push(
      source
        ? `${source} exists but is not merged into ${input.defaultBranch} through merge requests`
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
    forge
      .listMergeRequests?.(repo.path, {
        state: 'merged',
        targetBranch: repository.defaultBranch,
        limit: 50,
      })
      .catch(() => []) ?? [],
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
