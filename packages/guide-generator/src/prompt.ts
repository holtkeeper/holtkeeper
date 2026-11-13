import { guideSectionLabels } from '@holtkeeper/guide'
import { z } from 'zod'

import type { Evidence } from './evidence.ts'

/** Sections the generator writes; `commits` is rendered without an LLM. */
export const generatedSections = ['general', 'testing', 'testids', 'commits'] as const

export type GeneratedSection = (typeof generatedSections)[number]

/** Sections an LLM writes, in prompt order. */
export const llmSections = ['general', 'testing', 'testids'] as const

export type LlmSection = (typeof llmSections)[number]

export const isLlmSection = (section: GeneratedSection): section is LlmSection =>
  llmSections.some((name) => name === section)

/**
 * Bumped whenever the prompt or the output handling changes, so every section's hash changes and
 * the next run regenerates.
 */
export const GENERATOR_VERSION = 1

/** Most characters of one generated section. */
export const SECTION_CHARS = 1_200

const focus: Record<LlmSection, string> = {
  general:
    'how to install, build, run, lint, format and type-check here (exact commands, including the Makefile targets that wrap them and the linters a lint config enables), which tool versions to use, which CI jobs a change must pass, where code of each kind goes, and which existing docs and doc folders to read first (point to them, do not restate them).',
  testing:
    'which framework and import new tests use, where test files go and how they are named, the command that runs one test file and the whole suite, the build tags or flags tests behind tags need, and folders where coverage is weak.',
  testids:
    'which attribute to use, the naming pattern of values with two or three real examples from the evidence, and which elements carry the attribute.',
}

/** The system prompt of a generator run. */
export const GENERATOR_SYSTEM = [
  'You write the generated part of a repository guide that coding agents read before working in the repository.',
  'Rules:',
  '- State only what the evidence shows about this repository. Every bullet must follow from an evidence item; never invent files, commands, tools or versions.',
  '- No generic best practices or advice that would fit any project ("write clean code", "add tests for new features", "keep functions small", "follow the style guide"). If the evidence shows nothing specific for a section, return an empty list for it.',
  '- Imperative bullets, one line each, concrete: name commands, paths and config files exactly as they appear in the evidence.',
  `- At most 10 bullets and about ${SECTION_CHARS} characters per section. Do not describe the folder tree or repeat evidence verbatim; say how to work here.`,
  '- Team rules are already stated elsewhere: do not repeat them and never contradict them. Follow the team steering of each section.',
  'Answer with JSON only: {"sections": {"<section>": ["bullet", ...]}} with exactly the requested sections.',
].join('\n')

/**
 * The task context of a generator run: it stands in for the Guide, so the generator never reads
 * its own earlier output or the team rules twice.
 */
export const GENERATOR_CONTEXT =
  'Repository guide generator: the evidence and the team rules follow in the prompt.'

/** What the generator gets for one section. */
export interface SectionPrompt {
  section: LlmSection
  evidence: readonly Evidence[]
  /** Steering of the section's scopes, strongest first; may be empty. */
  steering: string
  /** Team rules of the section's scopes, strongest first; may be empty. */
  rules: string
}

/** The user prompt of a generator run over `sections`, with an optional one-off extra request. */
export function generatorPrompt(sections: readonly SectionPrompt[], extra?: string): string {
  const parts = sections.map((section) =>
    [
      `# Section ${section.section} (${guideSectionLabels[section.section]})`,
      `Cover: ${focus[section.section]}`,
      section.steering.trim() && `Team steering (follow it):\n${section.steering.trim()}`,
      section.rules.trim() &&
        `Team rules already stated (do not repeat or contradict):\n${section.rules.trim()}`,
      'Evidence:',
      ...section.evidence.map((item) => `## [${item.id}] ${item.label}\n${item.text}`),
    ]
      .filter(Boolean)
      .join('\n\n'),
  )
  return [
    `Write these sections: ${sections.map((section) => section.section).join(', ')}.`,
    ...parts,
    extra?.trim() && `Extra request for this run (from a maintainer):\n${extra.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The JSON a generator run answers with. */
export const generatorOutput = z.object({
  sections: z.object({
    general: z.array(z.string()).optional(),
    testing: z.array(z.string()).optional(),
    testids: z.array(z.string()).optional(),
  }),
})

export type GeneratorOutput = z.infer<typeof generatorOutput>

/**
 * Markdown bullets from a model's lines: list markers stripped, blanks and duplicates dropped,
 * cut at a whole bullet so the section stays within `SECTION_CHARS`.
 */
export function renderBullets(lines: readonly string[]): string {
  const seen = new Set<string>()
  const bullets: string[] = []
  let size = 0
  for (const line of lines) {
    const text = line
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
      .replaceAll(/\s+/g, ' ')
      .trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    const bullet = `- ${text}`
    if (size + bullet.length + 1 > SECTION_CHARS) break
    seen.add(key)
    bullets.push(bullet)
    size += bullet.length + 1
  }
  return bullets.join('\n')
}
