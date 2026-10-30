import { blankBlocks, onlyTemplate, type ScannedTag, scanTags } from './tags.ts'

/**
 * One kind of template file. Sources are replaceable: pass your own to `analyzeTestIds` to support
 * another framework or file layout.
 */
export interface TemplateSource {
  /** Short name shown in reports, e.g. `jsx`, `vue`. */
  name: string
  /** Whether this source reads the file (relative, `/`-separated path). */
  matches(file: string): boolean
  /** Opening tags of the file's templates; empty when it has none. */
  scan(text: string, file: string): ScannedTag[]
}

/** JSX and TSX, plus `.js`/`.mjs` files that contain JSX. Lit `html\`…\`` templates are read too. */
export const jsxSource: TemplateSource = {
  name: 'jsx',
  matches: (file) => /\.(jsx|tsx|js|mjs)$/.test(file),
  scan(text, file) {
    if (/\.m?js$/.test(file) && !/<\/[A-Za-z]|\/>/.test(text)) return []
    return scanTags(text, 'jsx')
  },
}

/** Vue single-file components: the outermost `<template>` block. */
export const vueSource: TemplateSource = {
  name: 'vue',
  matches: (file) => file.endsWith('.vue'),
  scan: (text) => scanTags(onlyTemplate(text), 'html'),
}

/** Svelte components: the markup outside `<script>` and `<style>`. */
export const svelteSource: TemplateSource = {
  name: 'svelte',
  matches: (file) => file.endsWith('.svelte'),
  scan: (text) => scanTags(blankBlocks(text, ['script', 'style']), 'html'),
}

/** HTML files and Angular component templates. */
export const htmlSource: TemplateSource = {
  name: 'html',
  matches: (file) => file.endsWith('.html'),
  scan: (text) => scanTags(blankBlocks(text, ['script', 'style']), 'html'),
}

/** The sources `analyzeTestIds` uses by default, by name. */
export const builtinSources: Record<string, TemplateSource> = {
  jsx: jsxSource,
  vue: vueSource,
  svelte: svelteSource,
  html: htmlSource,
}
