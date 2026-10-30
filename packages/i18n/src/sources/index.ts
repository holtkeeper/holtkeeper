import type { CatalogSource } from '../types.ts'
import { jsonSource } from './json.ts'
import { poSource } from './po.ts'
import { propertiesSource } from './properties.ts'
import { yamlSource } from './yaml.ts'

export { insertJson, jsonEntries, jsonSource, removeJson } from './json.ts'
export { CONTEXT_SEPARATOR, parsePo, poSource } from './po.ts'
export { DEFAULT_LOCALE, propertiesSource } from './properties.ts'
export { yamlEntries, yamlSource } from './yaml.ts'

/** Every catalog format the package reads: JSON, YAML, gettext and Java properties. */
export const defaultSources = (): CatalogSource[] => [
  jsonSource(),
  yamlSource(),
  poSource(),
  propertiesSource(),
]
