/** The example policies from docs/README.md, as stored in the `mergeRequests.policies` setting. */
export const examplePolicies: unknown = [
  {
    id: 'release-auto-approve',
    name: 'Approve releases from the release bot',
    when: {
      event: ['open', 'update', 'reopen'],
      sourceBranch: 'release/*',
      targetBranch: 'main',
      author: { users: ['release-bot'], bot: true },
    },
    actions: [
      {
        type: 'approve',
        requirePipeline: 'success',
        summary: 'Release {sourceBranch} approved: pipeline is green.',
      },
    ],
    skipAnalyzers: '*',
    stop: true,
  },
  {
    id: 'renovate-patch-automerge',
    name: 'Auto-merge Renovate patch updates',
    when: { author: 'renovate*', labels: { all: ['patch'] }, draft: false },
    actions: [
      { type: 'approve', requirePipeline: 'success' },
      { type: 'merge', squash: true, removeSourceBranch: true, whenPipelineSucceeds: true },
    ],
    skipAnalyzers: ['review'],
  },
  {
    id: 'docs-only',
    name: 'Label docs-only changes and skip code review',
    when: { event: ['open', 'update'], changedPaths: { all: ['**/*.md', 'docs/**'] } },
    actions: [{ type: 'label', add: ['docs-only'] }],
    skipAnalyzers: ['review'],
  },
  {
    id: 'large-needs-review',
    name: 'Large merge requests need a human reviewer',
    when: {
      event: ['open', 'update'],
      size: { minLines: 1000 },
      labels: { none: ['needs-review'] },
    },
    actions: [
      { type: 'label', add: ['needs-review'] },
      {
        type: 'comment',
        once: 'mergeRequest',
        body: '@{author} this merge request changes 1000+ lines, so it needs a human review before merging.',
      },
    ],
  },
]
