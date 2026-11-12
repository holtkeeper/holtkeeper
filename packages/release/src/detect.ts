import type {
  BranchRecord,
  GitForge,
  MergeRequestRecord,
  PipelineJob,
  RepoRef,
  TagRecord,
} from '@holtkeeper/forge'

import { findTickets, parseCommit } from './conventional.ts'
import { acceptanceLabel } from './settings.ts'

const sourceNames = ['development', 'develop', 'dev']

const CALVER = /^\d{4}\.\d{1,2}\.\d+$/u
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const CHANGELOG = /^changelog(?:\.md)?$/iu
const TRACKER_KEY = /^([A-Z][A-Z0-9]+)-\d+$/u
const DEPLOY = /deploy|rollout/iu
const MERGE_TITLE = /^Merge (?:branch|pull request|remote-tracking branch|tag|commit|changes)\b/u

/** What a detected setting or signal was read from. */
export type DetectionSignalKind =
  | 'merge-request'
  | 'label'
  | 'tag'
  | 'file'
  | 'commits'
  | 'pipeline-job'
  | 'branch'

/** The evidence behind one suggested setting. */
export interface DetectionSource {
  kind: DetectionSignalKind
  /** What was read: `!12`, a label, a tag, a file path, a share like `96%`, job or branch names. */
  value: string
  /** Where it was read: a branch, a tag, `labels`, `tags`, `branches`. */
  where: string
  /** ISO 8601 time of the newest piece of evidence, when known. */
  at?: string
}

/** A share of sampled titles that match, with what was sampled. `share` is 0 when nothing was. */
export interface DetectionShare {
  share: number
  matched: number
  sampled: number
  /** `commits on <branch>` or `merged merge requests`. */
  where: string
}

/** A pipeline job that looks like it deploys. */
export interface DetectionDeployJob {
  name: string
  stage: string
  status: string
  manual: boolean
  /** The forge's environment name, else one derived from the job name. */
  environment: string
  /** Branch or tag of the pipeline it was read from. */
  ref: string
  at?: string
}

/** What detection read from the repository, whether or not it changed a suggested setting. */
export interface DetectionSignals {
  /** Labels on the merged release merge requests (on any merged one when no release flow shows), most used first. */
  releaseLabels: { name: string; mergeRequests: number; of: number }[]
  /** Path of the changelog at the repository root; absent when there is none. */
  changelog?: string
  /** Conventional Commits titles among commit titles of the default branch (merged merge requests when no commits were read). */
  conventional: DetectionShare
  /** Merged merge requests whose title or source branch carries a tracker key (commit titles when none were read); `keys` are the tracker project keys, most used first. */
  tracker: DetectionShare & { keys: string[] }
  /** Deploy jobs of the latest pipeline of the newest tag, else of the default branch. */
  deployJobs: DetectionDeployJob[]
  /** The branch versions would be tagged on, when the forge reported whether it is protected. */
  targetBranch?: { name: string; protected: boolean }
}

/**
 * A suggested flow for a repository without its own settings: `settings` is a partial releases
 * setting, `reasons` explain it in sentences, `signals` hold everything read, and `provenance` maps
 * each suggested setting path (`flow.source`, `deploy.environments`, ...) to its evidence. Settings
 * without provenance are Holtkeeper defaults.
 */
export interface FlowDetection {
  mode: 'merge-request' | 'trunk' | 'external'
  settings: Record<string, unknown>
  reasons: string[]
  signals: DetectionSignals
  provenance: Record<string, DetectionSource>
}

/** What `detectFlow` reads: branches, tags, merged merge requests, root files, commit titles and pipeline jobs. */
export interface DetectionInput {
  defaultBranch: string
  branches: readonly (Pick<BranchRecord, 'name'> & Partial<Pick<BranchRecord, 'protected'>>)[]
  /** Most recently updated first. */
  tags: readonly (Pick<TagRecord, 'name'> & Partial<Pick<TagRecord, 'committedAt'>>)[]
  /** Merged merge requests, newest first. */
  merged: readonly (Pick<MergeRequestRecord, 'sourceBranch' | 'targetBranch'> &
    Partial<Pick<MergeRequestRecord, 'id' | 'title' | 'labels' | 'mergedAt'>>)[]
  /** Paths at the repository root. */
  files: readonly string[]
  /** Commit titles of `ref`, newest first. */
  commits?: { ref: string; titles: readonly string[] }
  /** Jobs of the latest pipeline of `ref`. */
  pipeline?: {
    ref: string
    jobs: readonly (Pick<PipelineJob, 'name' | 'stage' | 'status' | 'manual'> &
      Partial<Pick<PipelineJob, 'environment' | 'createdAt' | 'finishedAt'>>)[]
  }
}

type Merged = DetectionInput['merged'][number]
type Job = NonNullable<DetectionInput['pipeline']>['jobs'][number]

const percent = (share: number) => `${Math.round(share * 100)}%`

const shareOf = (matched: number, sampled: number, where: string): DetectionShare => ({
  share: sampled ? matched / sampled : 0,
  matched,
  sampled,
  where,
})

const mrRef = (mr: Merged | undefined) => (mr?.id === undefined ? 'merge requests' : `!${mr.id}`)

const isDeployJob = (job: Pick<Job, 'name' | 'stage' | 'environment'>) =>
  Boolean(job.environment) || DEPLOY.test(job.name) || DEPLOY.test(job.stage)

function environmentOf(job: Job): string {
  if (job.environment) return job.environment
  const name = job.name
    .split(/[-_:\s/]+/u)
    .filter((part) => part && !DEPLOY.test(part))
    .join('-')
  return name || job.name
}

function countBy<T>(items: readonly T[], keys: (item: T) => readonly string[]) {
  const counts = new Map<string, number>()
  for (const item of items)
    for (const key of new Set(keys(item))) counts.set(key, (counts.get(key) ?? 0) + 1)
  return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const trackerKeys = (text: string) =>
  findTickets(text).flatMap((id) => {
    const key = TRACKER_KEY.exec(id)?.[1]
    return key ? [key] : []
  })

function readShares(input: DetectionInput) {
  const titles = (input.commits?.titles ?? []).filter((title) => !MERGE_TITLE.test(title))
  const titled = input.merged.filter((mr) => mr.title)
  const commitsWhere = `commits on ${input.commits?.ref ?? input.defaultBranch}`
  const conventionalSample = titles.length ? titles : titled.map((mr) => mr.title ?? '')
  const conventional = shareOf(
    conventionalSample.filter((title) => parseCommit(title).type !== undefined).length,
    conventionalSample.length,
    titles.length ? commitsWhere : 'merged merge requests',
  )
  const trackerSample = titled.length
    ? titled.map((mr) => trackerKeys(`${mr.title ?? ''}\n${mr.sourceBranch}`))
    : titles.map(trackerKeys)
  const tracker = {
    ...shareOf(
      trackerSample.filter((keys) => keys.length).length,
      trackerSample.length,
      titled.length ? 'merged merge requests' : commitsWhere,
    ),
    keys: countBy(trackerSample, (keys) => keys).map(([key]) => key),
  }
  return { conventional, tracker }
}

function readDeployJobs(input: DetectionInput): DetectionDeployJob[] {
  const pipeline = input.pipeline
  if (!pipeline) return []
  const seen = new Set<string>()
  const jobs: DetectionDeployJob[] = []
  for (const job of pipeline.jobs) {
    if (!isDeployJob(job)) continue
    const environment = environmentOf(job)
    if (seen.has(environment)) continue
    seen.add(environment)
    const at = job.finishedAt ?? job.createdAt
    jobs.push({
      name: job.name,
      stage: job.stage,
      status: job.status,
      manual: job.manual,
      environment,
      ref: pipeline.ref,
      ...(at ? { at } : {}),
    })
  }
  return jobs
}

/**
 * Suggests a release flow from what a repository already does: a release tool's files mean
 * `external`, merge requests from a long-lived development branch into another branch mean the
 * merge request flow into the branch it is merged into most (`flow.target` when that is not the
 * default branch, which may be the development branch itself), otherwise trunk. The tag format and
 * scheme follow the existing tags; labels shared by release merge requests, a root changelog,
 * deploy jobs of the latest pipeline and a protected target branch add their settings. Pure.
 */
export function detectFlow(input: DetectionInput): FlowDetection {
  const reasons: string[] = []
  const settings: Record<string, unknown> = {}
  const provenance: Record<string, DetectionSource> = {}
  const { conventional, tracker } = readShares(input)
  const deployJobs = readDeployJobs(input)
  const changelog = input.files.find((file) => CHANGELOG.test(file))

  const branches = new Set(input.branches.map((branch) => branch.name))
  const pairs = new Map<string, { source: string; target: string; requests: Merged[] }>()
  for (const mr of input.merged) {
    if (
      !sourceNames.includes(mr.sourceBranch) ||
      sourceNames.includes(mr.targetBranch) ||
      !branches.has(mr.sourceBranch) ||
      !branches.has(mr.targetBranch)
    )
      continue
    const key = `${mr.sourceBranch}\0${mr.targetBranch}`
    const pair = pairs.get(key) ?? {
      source: mr.sourceBranch,
      target: mr.targetBranch,
      requests: [],
    }
    pair.requests.push(mr)
    pairs.set(key, pair)
  }
  const release = [...pairs.values()].toSorted((a, b) => b.requests.length - a.requests.length)[0]
  const labelled = release?.requests ?? input.merged
  const releaseLabels = countBy(labelled, (mr) =>
    (mr.labels ?? []).filter((label) => release || /release/iu.test(label)),
  ).map(([name, count]) => ({ name, mergeRequests: count, of: labelled.length }))

  const targetName = release?.target ?? input.defaultBranch
  const targetRecord = input.branches.find((branch) => branch.name === targetName)
  const signals: DetectionSignals = {
    releaseLabels,
    ...(changelog ? { changelog } : {}),
    conventional,
    tracker,
    deployJobs,
    ...(targetRecord?.protected === undefined
      ? {}
      : { targetBranch: { name: targetName, protected: targetRecord.protected } }),
  }

  const packageTags = input.tags.filter((tag) => /^(?:@[^/]+\/)?[\w.-]+@\d/u.test(tag.name))
  if (input.files.includes('.changeset') || packageTags.length > input.tags.length / 2) {
    const changeset = input.files.includes('.changeset')
    reasons.push(
      changeset
        ? 'a .changeset folder: changesets releases it'
        : 'tags name packages (name@version): a release tool tags it',
    )
    const tag = packageTags[0]
    provenance['flow.mode'] = changeset
      ? { kind: 'file', value: '.changeset', where: input.defaultBranch }
      : {
          kind: 'tag',
          value: tag?.name ?? '',
          where: 'tags',
          ...(tag?.committedAt ? { at: tag.committedAt } : {}),
        }
    return {
      mode: 'external',
      settings: { flow: { mode: 'external' } },
      reasons,
      signals,
      provenance,
    }
  }

  const source = release?.source ?? sourceNames.find((name) => branches.has(name))
  let mode: FlowDetection['mode'] = 'trunk'
  if (release) {
    mode = 'merge-request'
    const newest = release.requests[0]
    const evidence: DetectionSource = {
      kind: 'merge-request',
      value: mrRef(newest),
      where: release.target,
      ...(newest?.mergedAt ? { at: newest.mergedAt } : {}),
    }
    settings['flow'] = {
      mode: 'merge-request',
      source: release.source,
      ...(release.target === input.defaultBranch ? {} : { target: release.target }),
    }
    provenance['flow.mode'] = evidence
    provenance['flow.source'] = evidence
    if (release.target !== input.defaultBranch) provenance['flow.target'] = evidence
    reasons.push(
      `${release.requests.length} merge request(s) from ${release.source} into ${release.target}`,
    )
  } else {
    settings['flow'] = { mode: 'trunk' }
    provenance['flow.mode'] = {
      kind: 'branch',
      value: source ?? input.defaultBranch,
      where: 'branches',
    }
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
  const versionTags = input.tags.filter((tag) => tag.name.startsWith(prefix))
  const versionOf = (name: string) => name.slice(prefix.length)
  const calverTags = versionTags.filter((tag) => CALVER.test(versionOf(tag.name)))
  const semverTags = versionTags.filter(
    (tag) => SEMVER.test(versionOf(tag.name)) && !CALVER.test(versionOf(tag.name)),
  )
  const fromTag = (tag: (typeof versionTags)[number] | undefined): DetectionSource | undefined =>
    tag && {
      kind: 'tag',
      value: tag.name,
      where: 'tags',
      ...(tag.committedAt ? { at: tag.committedAt } : {}),
    }
  let versionSource: DetectionSource | undefined
  if (calverTags.length > semverTags.length && calverTags.length > 0) {
    settings['version'] = { scheme: 'calver', tagFormat: `${prefix}{version}` }
    versionSource = fromTag(calverTags[0])
    reasons.push(`${calverTags.length} calendar version tag(s)`)
  } else {
    settings['version'] = { scheme: 'semver', tagFormat: `${prefix}{version}` }
    versionSource = fromTag(semverTags[0])
    reasons.push(
      semverTags.length > 0
        ? `${semverTags.length} semantic version tag(s) ${prefix ? 'with' : 'without'} a v prefix`
        : 'no version tags yet: semantic versions with a v prefix',
    )
  }
  if (versionSource) {
    provenance['version.scheme'] = versionSource
    provenance['version.tagFormat'] = versionSource
  } else if (conventional.share >= 0.5) {
    provenance['version.scheme'] = {
      kind: 'commits',
      value: percent(conventional.share),
      where: conventional.where,
    }
  }

  if (release) {
    const labelSource = (name: string): DetectionSource => {
      const newest = release.requests.find((mr) => mr.labels?.includes(name))
      return {
        kind: 'label',
        value: name,
        where: mrRef(newest),
        ...(newest?.mergedAt ? { at: newest.mergedAt } : {}),
      }
    }
    const shared = releaseLabels
      .filter((label) => label.name !== acceptanceLabel && label.mergeRequests * 2 >= label.of)
      .map((label) => label.name)
    if (shared.length) {
      settings['mergeRequest'] = { labels: shared }
      provenance['mergeRequest.labels'] = labelSource(shared[0]!)
      reasons.push(`release merge requests are labelled ${shared.join(', ')}`)
    }
    if (releaseLabels.some((label) => label.name === acceptanceLabel)) {
      settings['acceptance'] = 'label'
      provenance['acceptance'] = labelSource(acceptanceLabel)
      reasons.push(`release merge requests were accepted with the ${acceptanceLabel} label`)
    }
  }

  if (changelog) {
    settings['changelogFile'] = true
    provenance['changelogFile'] = { kind: 'file', value: changelog, where: input.defaultBranch }
    reasons.push(`${changelog} exists: the notes of each version are prepended to it`)
  }

  if (deployJobs.length) {
    settings['deploy'] = {
      environments: deployJobs.map((job, index) => ({
        name: job.environment,
        ...(job.name === job.environment ? {} : { job: job.name }),
        ...(index > 0 ? { after: deployJobs[index - 1]!.environment } : {}),
        confirm: job.manual,
      })),
    }
    const newest = deployJobs
      .map((job) => job.at)
      .filter((at) => at !== undefined)
      .toSorted()
      .at(-1)
    provenance['deploy.environments'] = {
      kind: 'pipeline-job',
      value: deployJobs.map((job) => job.name).join(', '),
      where: deployJobs[0]!.ref,
      ...(newest ? { at: newest } : {}),
    }
    reasons.push(
      `${deployJobs.length} deploy job(s) in the latest pipeline of ${deployJobs[0]!.ref}: ${deployJobs
        .map((job) => `${job.name}${job.manual ? ' (manual)' : ''}`)
        .join(', ')}`,
    )
  }

  if (signals.targetBranch?.protected) {
    settings['gates'] = { pipeline: true }
    provenance['gates.pipeline'] = { kind: 'branch', value: targetName, where: 'branches' }
    reasons.push(`${targetName} is protected: a failed pipeline blocks the release step`)
  }

  if (conventional.sampled)
    reasons.push(
      `${percent(conventional.share)} of ${conventional.sampled} ${conventional.where} follow Conventional Commits`,
    )
  if (tracker.matched)
    reasons.push(
      `${percent(tracker.share)} of ${tracker.sampled} ${tracker.where} carry a tracker key (${tracker.keys.slice(0, 3).join(', ')})`,
    )

  return { mode, settings, reasons, signals, provenance }
}

/**
 * Reads what `detectFlow` needs from the forge: branches, tags, merged merge requests, root files,
 * commit titles of the default branch and the jobs of the latest pipeline of the newest tag (of the
 * default branch when that has no deploy jobs). Reads a forge lacks or fails count as empty.
 */
export async function detectRepositoryFlow(forge: GitForge, repo: RepoRef): Promise<FlowDetection> {
  const repository = await forge.getRepository(repo.path)
  const defaultBranch = repository.defaultBranch
  const [branches, tags, merged, files, commits] = await Promise.all([
    forge.listBranches?.(repo.path).catch(() => []) ?? [],
    forge.listTags?.(repo.path, { limit: 100 }).catch(() => []) ?? [],
    forge.listMergeRequests?.(repo.path, { state: 'merged', limit: 100 }).catch(() => []) ?? [],
    forge.listFiles?.(repo.path).catch(() => []) ?? [],
    forge.listCommits?.(repo.path, { ref: defaultBranch, limit: 200 }).catch(() => []) ?? [],
  ])
  const jobsOf = async (ref: string) =>
    (await forge.listPipelineJobs?.(repo.path, { ref, limit: 100 }).catch(() => [])) ?? []
  let pipeline: DetectionInput['pipeline']
  if (forge.listPipelineJobs) {
    const tag = tags[0]?.name
    const tagJobs = tag ? await jobsOf(tag) : []
    pipeline = tagJobs.some(isDeployJob)
      ? { ref: tag!, jobs: tagJobs }
      : { ref: defaultBranch, jobs: await jobsOf(defaultBranch) }
  }
  return detectFlow({
    defaultBranch,
    branches,
    tags,
    merged,
    files: files.map((entry) => entry.path),
    ...(commits.length
      ? { commits: { ref: defaultBranch, titles: commits.map((commit) => commit.title) } }
      : {}),
    ...(pipeline ? { pipeline } : {}),
  })
}
