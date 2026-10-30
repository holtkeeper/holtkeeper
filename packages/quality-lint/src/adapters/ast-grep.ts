import { hasAny, projectBinary } from '../detect.ts'
import { parseSarif } from '../sarif.ts'
import type { LinterAdapter } from '../types.ts'

/**
 * ast-grep rules through `ast-grep scan --format sarif`. Detected by `sgconfig.yml`/`.yaml`. The
 * binary is called `ast-grep`, not `sg`, which is a different tool on many Linux systems.
 */
export const astGrepAdapter = (): LinterAdapter => ({
  name: 'ast-grep',
  detect: (dir) => hasAny(dir, ['sgconfig.yml', 'sgconfig.yaml']),
  command: (dir) => [projectBinary(dir, 'ast-grep'), 'scan', '--format', 'sarif'],
  parse: (stdout, dir) => parseSarif(stdout, { dir, tool: 'ast-grep' }),
})
