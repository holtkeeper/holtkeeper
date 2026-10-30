/** Kind of a terminal line; drives its color. */
type LineKind = 'out' | 'dim' | 'head' | 'ok' | 'warn' | 'bad' | 'key'

export interface DemoStep {
  title: string
  text: string
  command: string
  output: [LineKind, string][]
  pause: number
}

/**
 * Output follows the CLI's own formatters: `formatReport` in apps/cli/src/audit.ts and
 * `formatReportText` in apps/cli/src/analyze.ts, with report titles and metric labels from each
 * analysis kind.
 */
export const steps: DemoStep[] = [
  {
    title: 'Check the config',
    text: 'Typed with zod, validated without secrets.',
    command: 'holtkeeper validate-config',
    output: [['ok', 'config is valid: 1 forge(s), 2 group(s), 0 plugin(s)']],
    pause: 1800,
  },
  {
    title: 'See what applies',
    text: 'Groups, merged traits and plugin options for one repository.',
    command: 'holtkeeper explain work:games/slots-x',
    output: [
      ['out', '{'],
      ['out', '  "repo": {'],
      ['out', '    "forge": "work",'],
      ['out', '    "path": "games/slots-x"'],
      ['out', '  },'],
      ['out', '  "groups": ['],
      ['out', '    "games"'],
      ['out', '  ],'],
      ['out', '  "traits": {'],
      ['out', '    "ssr": true'],
      ['out', '  },'],
      ['out', '  "plugins": []'],
      ['out', '}'],
    ],
    pause: 2200,
  },
  {
    title: 'Audit and fix',
    text: 'OSV-Scanner finds, a chain of fixers repairs, a rescan decides.',
    command: 'holtkeeper audit ./games/slots-x --fix --allowlist allowlist.json',
    output: [
      ['head', 'osv-scanner: 1 vulnerable, 1 allowlisted, 7 fixed'],
      ['warn', '  low      cookie@0.4.0  GHSA-pxg6-pf52-xh8x  package-lock.json  fix 0.7.0'],
      ['dim', 'fixer osv-scanner-fix on package-lock.json: claimed 6/8'],
      ['dim', 'fixer js on package-lock.json: claimed 1/2'],
      ['ok', 'changed: package.json, package-lock.json'],
    ],
    pause: 2800,
  },
  {
    title: 'Describe a release',
    text: 'Commits grouped by type and scope, identical messages collapsed.',
    command: 'holtkeeper analyze changelog . --from v2.3.0 --to v2.4.0',
    output: [
      ['head', 'Changelog v2.4.0'],
      ['dim', 'v2.3.0 → v2.4.0 · 42 commits'],
      ['out', ''],
      ['key', '  Commits: 42'],
      ['key', '  Contributors: 6'],
      ['key', '  Features: 9'],
      ['key', '  Fixes: 14'],
      ['bad', '  Breaking changes: 1'],
      ['out', ''],
      ['head', '## Highlights'],
      ['bad', '  [bad] feat(api)!: drop legacy session tokens'],
      ['head', '## Changelog'],
      ['out', '  - feat(lobby): tournament banner'],
      ['out', '  - fix(slots): reel stops late on slow devices ×4'],
      ['out', '  - perf(assets): AVIF backgrounds'],
    ],
    pause: 3200,
  },
  {
    title: 'Score the risk',
    text: 'Built from stored analyses, with what QA should test first.',
    command: 'holtkeeper analyze release-risk . --ref v2.4.0',
    output: [
      ['head', 'Release risk'],
      ['dim', 'v2.4.0'],
      ['out', ''],
      ['warn', '  Risk score: 34'],
      ['warn', '  Risk level: medium'],
      ['key', '  Confidence: 85.0%'],
      ['key', '  Risk factors: 5'],
      ['out', ''],
      ['head', '## Risk factors'],
      ['bad', '  [bad] Bundle growth: +9'],
      ['warn', '  [warning] Size of change: +8'],
      ['warn', '  [warning] Changed code without tests: +7'],
      ['warn', '  [warning] Breaking changes and reverts: +6'],
      ['warn', '  [warning] Contributors and hotspots: +4'],
    ],
    pause: 3200,
  },
  {
    title: 'Review a merge request',
    text: 'Inline comments with suggestions, a summary and a verdict.',
    command: 'holtkeeper analyze review . --mr 482 --max-comments 15',
    output: [
      ['head', 'Review of !482 Lobby: tournament banner'],
      ['dim', 'feat/tournament-banner → main by mira'],
      ['out', ''],
      ['bad', '  Verdict: needs-changes'],
      ['key', '  Comments: 3'],
      ['key', '  Major and critical: 1'],
      ['key', '  Suggestions: 3'],
      ['key', '  Files reviewed: 7'],
      ['out', ''],
      ['head', '## Findings'],
      ['bad', '  [bad] Countdown interval keeps running after unmount'],
      ['warn', "  [warning] Prize amount ignores the player's locale"],
      ['out', '  [info] Banner variants repeat the same class names'],
      ['head', '## Suggestions'],
      ['ok', '  * Clear the interval in the effect cleanup'],
    ],
    pause: 3600,
  },
]
