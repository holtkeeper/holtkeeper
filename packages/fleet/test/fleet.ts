const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** Four repositories: a bun monorepo, an npm app, a pnpm app and a Go service. */
export const fleetFiles: Record<string, Record<string, string>> = {
  'acme/web': {
    'package.json': json({
      name: 'web',
      workspaces: ['packages/*'],
      engines: { node: '>=22' },
      dependencies: { react: '^19.0.0', '@acme/ui': '^3.0.0' },
      devDependencies: { typescript: '^5.6.0' },
    }),
    'packages/legacy/package.json': json({
      name: 'legacy',
      dependencies: { react: '^18.2.0', web: 'workspace:*' },
    }),
    'bun.lock': `{
      "lockfileVersion": 1,
      "workspaces": {
        "": { "name": "web" },
        "packages/legacy": { "name": "legacy" },
      },
      "packages": {
        "react": ["react@19.1.0", "", {}, ""],
        "legacy/react": ["react@18.3.1", "", {}, ""],
        "@acme/ui": ["@acme/ui@3.2.0", "", {}, ""],
        "typescript": ["typescript@5.6.3", "", {}, ""],
      },
    }`,
    '.nvmrc': '22\n',
    '.gitlab-ci.yml': 'include:\n  - project: acme/ci\n    file: /node.yml\n',
  },
  'acme/admin': {
    'package.json': json({
      name: 'admin',
      engines: { node: '>=18' },
      dependencies: { react: '^17.0.2', '@acme/ui': '^2.4.0' },
      devDependencies: { typescript: '~5.4.0' },
    }),
    'package-lock.json': json({
      lockfileVersion: 3,
      packages: {
        '': { name: 'admin' },
        'node_modules/react': { version: '17.0.2' },
        'node_modules/@acme/ui': { version: '2.4.1' },
        'node_modules/typescript': { version: '5.4.5' },
      },
    }),
    '.nvmrc': '18\n',
    '.gitlab-ci.yml': 'stages:\n  - test\n',
  },
  'acme/shop': {
    'package.json': json({
      name: 'shop',
      dependencies: { react: '^19.1.0' },
      devDependencies: { typescript: '^5.6.0' },
    }),
    'pnpm-lock.yaml': [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      react:',
      '        specifier: ^19.1.0',
      '        version: 19.1.0',
      '    devDependencies:',
      '      typescript:',
      '        specifier: ^5.6.0',
      '        version: 5.7.2',
      '',
    ].join('\n'),
    '.gitlab-ci.yml': 'include:\n  - project: acme/ci\n    file: /node.yml\nstages:\n  - build\n',
  },
  'acme/api': {
    'go.mod': [
      'module github.com/acme/api',
      '',
      'go 1.22',
      '',
      'require (',
      '\tgithub.com/acme/kit v1.4.0',
      '\tgolang.org/x/sys v0.20.0 // indirect',
      ')',
      '',
    ].join('\n'),
    '.nvmrc': '22\n',
    Dockerfile: 'FROM golang:1.21\nWORKDIR /src\n',
  },
  'acme/templates': {
    'gitlab-ci.yml': 'include:\n  - project: acme/ci\n    file: /node.yml\n',
  },
}

export const latestVersions: Record<string, string> = {
  'npm:react': '19.1.0',
  'npm:@acme/ui': '3.2.0',
  'npm:typescript': '5.7.2',
  'Go:github.com/acme/kit': 'v2.0.1',
}
