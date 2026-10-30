/** A small project knip finds dead code in; `knip-report.json` is knip 6.44's JSON report on it. */
export const fixture: Record<string, string> = {
  'package.json':
    '{\n  "name": "fixture",\n  "type": "module",\n  "main": "src/index.ts",\n  "dependencies": {\n    "left-pad": "^1.3.0",\n    "zod": "^4.0.0"\n  },\n  "devDependencies": {\n    "is-odd": "^3.0.1"\n  }\n}\n',
  'src/index.ts':
    "import { z } from 'zod'\nimport chalk from 'chalk'\nimport { used, helper, Level, ns } from './util.ts'\nimport './missing.ts'\n\nexport const main = () => used() + helper(z, chalk) + Level.Low + ns.kept\n",
  'src/util.ts':
    'export function used() {\n  return 1\n}\n\nexport const helper = (a: unknown, b: unknown) => String(a) + String(b)\n\nexport const unusedConst = 42\n\nexport function unusedFn() {\n  return 2\n}\n\nexport type UnusedType = { a: number }\n\nexport enum Color {\n  Red,\n  Green,\n}\n\nconst local = 1\nconst other = 2\nexport { local, other }\nexport default used\nexport { used as alias }\n\nexport enum Level {\n  Low,\n  High,\n}\n\nexport namespace ns {\n  export const kept = 1\n  export const dropped = 2\n}\n',
  'src/orphan.ts': 'export const orphan = true\n',
}
