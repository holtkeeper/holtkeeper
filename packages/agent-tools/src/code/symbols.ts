import { join } from 'node:path'

import type { SgNode } from '@ast-grep/napi'
import type { AgentTool } from '@holtkeeper/agent'
import { z } from 'zod'

import { type Budget, clip, limitLines, renderBlocks } from '../budget.ts'
import { insideDir, listFiles, readText, relativePath, splitLines } from '../files.ts'
import { defineTool } from '../tool.ts'
import {
  formatEntry,
  headOf,
  languageOf,
  linesOf,
  outline,
  parseSource,
  SCRIPT_EXTENSIONS,
} from './syntax.ts'

const paths = z
  .array(z.string())
  .optional()
  .describe('Glob patterns relative to the repository root to limit the search')

/** `code.outline`: the declarations of one file with line ranges. */
export function outlineTool(budget: Budget): AgentTool {
  return defineTool({
    name: 'code.outline',
    description:
      'Outline of a TypeScript/JavaScript file: imports, functions, classes with members, interfaces, types, enums, variables and exports, each as "start-end signature". Read this before code.read so you only read the ranges you need.',
    input: z.object({
      path: z.string().min(1).describe('File path relative to the repository root'),
    }),
    async run({ path }, { dir }) {
      const absolute = insideDir(dir, path)
      const language = languageOf(absolute)
      if (!language || !SCRIPT_EXTENSIONS.some((ext) => absolute.toLowerCase().endsWith(ext)))
        throw new Error(`outline supports TypeScript and JavaScript files, not ${path}`)
      const text = await readText(absolute)
      if (text === undefined) throw new Error(`${path} is missing, binary or too large`)
      const entries = outline(parseSource(language, text), budget.maxLineLength)
      const header = `${relativePath(dir, absolute)} (${splitLines(text).length} lines)`
      if (entries.length === 0) return `${header}\nno declarations`
      return [
        header,
        ...limitLines(entries.map(formatEntry), budget.maxResultLines - 1, 'symbols'),
      ].join('\n')
    },
  })
}

const DEFINITION_KINDS = [
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'variable_declarator',
  'method_definition',
  'method_signature',
  'abstract_method_signature',
  'public_field_definition',
  'property_signature',
  'module',
  'internal_module',
]

const REFERENCE_KINDS = [
  'identifier',
  'type_identifier',
  'property_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
]

const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u

function exactName(name: string): string {
  return `^${name.replaceAll('$', '\\$')}$`
}

/** The statement that carries a definition's modifiers (`export`, `const`). */
function statementOf(node: SgNode): SgNode {
  let current = node
  if (current.kind() === 'variable_declarator') current = current.parent() ?? current
  const parent = current.parent()
  if (parent && (parent.kind() === 'export_statement' || parent.kind() === 'ambient_declaration'))
    current = parent
  return current
}

interface ScriptFile {
  path: string
  text: string
  root: SgNode
}

async function* scriptFiles(
  dir: string,
  name: string,
  globs: readonly string[] | undefined,
  signal: AbortSignal,
): AsyncGenerator<ScriptFile> {
  for (const path of await listFiles(dir, {
    extensions: SCRIPT_EXTENSIONS,
    signal,
    ...(globs ? { globs } : {}),
  })) {
    signal.throwIfAborted()
    const text = await readText(join(dir, path))
    if (text === undefined || !text.includes(name)) continue
    const language = languageOf(path)
    if (!language) continue
    yield { path, text, root: parseSource(language, text) }
  }
}

function checkName(name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(`${name} is not an identifier`)
}

/** `code.symbol`: where a name is defined. */
export function symbolTool(budget: Budget): AgentTool {
  return defineTool({
    name: 'code.symbol',
    description:
      'Find definitions of a name (function, class, interface, type, enum, variable, method, property) across TypeScript/JavaScript files. Returns "file:start-end signature" per definition.',
    input: z.object({ name: z.string().min(1), paths }),
    async run({ name, paths: globs }, { dir, signal }) {
      checkName(name)
      const rule = {
        rule: {
          any: DEFINITION_KINDS.map((kind) => ({ kind })),
          has: { field: 'name', regex: exactName(name) },
        },
      }
      const lines: string[] = []
      for await (const file of scriptFiles(dir, name, globs, signal)) {
        for (const node of file.root.findAll(rule)) {
          const { start, end } = linesOf(node)
          const head = headOf(statementOf(node), budget.maxLineLength)
          lines.push(`${file.path}:${start === end ? start : `${start}-${end}`} ${head}`)
        }
      }
      if (lines.length === 0) return `no definitions of ${name}`
      return limitLines(
        lines,
        Math.min(budget.maxResultLines, budget.maxHits + 1),
        'definitions',
      ).join('\n')
    },
  })
}

function isDefinitionName(node: SgNode): boolean {
  const parent = node.parent()
  if (!parent || !DEFINITION_KINDS.includes(String(parent.kind()))) return false
  return parent.field('name')?.id() === node.id()
}

/** `code.references`: where a name is used, definitions excluded. */
export function referencesTool(budget: Budget): AgentTool {
  return defineTool({
    name: 'code.references',
    description:
      'Find usages of a name (identifier matches in TypeScript/JavaScript, imports included, definitions excluded). Returns "line: code" grouped by file. Strings and comments do not count; use code.grep for those.',
    input: z.object({ name: z.string().min(1), paths }),
    async run({ name, paths: globs }, { dir, signal }) {
      checkName(name)
      const rule = {
        rule: { any: REFERENCE_KINDS.map((kind) => ({ kind })), regex: exactName(name) },
      }
      const blocks: string[][] = []
      let total = 0
      for await (const file of scriptFiles(dir, name, globs, signal)) {
        const lines = splitLines(file.text)
        const seen = new Set<number>()
        for (const node of file.root.findAll(rule)) {
          if (isDefinitionName(node)) continue
          seen.add(linesOf(node).start)
        }
        if (seen.size === 0) continue
        total += seen.size
        blocks.push([
          file.path,
          ...[...seen]
            .toSorted((a, b) => a - b)
            .map(
              (line) => `  ${line}: ${clip((lines[line - 1] ?? '').trim(), budget.maxLineLength)}`,
            ),
        ])
      }
      if (blocks.length === 0) return `no references to ${name}`
      return `${total} lines in ${blocks.length} files\n${renderBlocks(blocks, { ...budget, maxResultLines: budget.maxResultLines - 1 }, 'files with references')}`
    },
  })
}
