import { describe, expect, test } from 'bun:test'

import {
  globMatches,
  commonFolder,
  folderPattern,
  literalDepth,
  parentFolder,
  pathAncestors,
  patternMatches,
  patternWithin,
  sharedShape,
} from './paths.ts'

describe('patternWithin', () => {
  test('compares segment by segment', () => {
    expect(patternWithin('a/b/c', 'a/**')).toBe(true)
    expect(patternWithin('a/*/c', 'a/**')).toBe(true)
    expect(patternWithin('a/**', 'a/**')).toBe(true)
    expect(patternWithin('a/b/**', 'a/**')).toBe(true)
    expect(patternWithin('a/**', 'a/b/**')).toBe(false)
    expect(patternWithin('a/*/c', 'a/b/*')).toBe(false)
    expect(patternWithin('a/b/c', '**/c')).toBe(true)
    expect(patternWithin('a/**/c', '**/c')).toBe(true)
    expect(patternWithin('a/**', '**/c')).toBe(false)
    expect(patternWithin('a/b', 'a/b/**')).toBe(false)
    expect(patternWithin('a/b/c', 'a/b/**')).toBe(true)
    expect(patternWithin('a/b/**', 'a/**')).toBe(true)
    expect(patternWithin('a/**', '**')).toBe(true)
    expect(patternWithin('c', '**/c')).toBe(true)
  })

  test('keeps forges apart', () => {
    expect(patternWithin('work:a/b', 'a/**')).toBe(true)
    expect(patternWithin('a/b', 'work:a/**')).toBe(false)
    expect(patternWithin('home:a/b', 'work:a/**')).toBe(false)
  })

  test('treats partial wildcards conservatively', () => {
    expect(patternWithin('a/app-x', 'a/app-*')).toBe(true)
    expect(patternWithin('a/app-*', 'a/*')).toBe(true)
    expect(patternWithin('a/*', 'a/app-*')).toBe(false)
    expect(patternWithin('a/app-*', 'a/app-*')).toBe(true)
  })
})

test('patternMatches honours the forge', () => {
  expect(patternMatches('acme/**', 'work', 'acme/a')).toBe(true)
  expect(patternMatches('work:acme/**', 'home', 'acme/a')).toBe(false)
})

test('literalDepth counts the leading literal folders', () => {
  expect(literalDepth('acme/round/**')).toBe(2)
  expect(literalDepth('work:acme/*/web')).toBe(1)
  expect(literalDepth('**/web')).toBe(0)
})

describe('folders', () => {
  test('ancestors, parent and common folder', () => {
    expect(pathAncestors('a/b/c')).toEqual(['a/b', 'a'])
    expect(pathAncestors('a')).toEqual([])
    expect(parentFolder('a/b/c')).toBe('a/b')
    expect(parentFolder('a')).toBeUndefined()
    expect(commonFolder(['a/b/c', 'a/b/d'])).toBe('a/b')
    expect(commonFolder(['a/b/c', 'a/x/d'])).toBe('a')
    expect(commonFolder(['a/b', 'x/b'])).toBeUndefined()
    expect(commonFolder(['a/bc/d', 'a/b/d'])).toBe('a')
    expect(commonFolder([])).toBeUndefined()
  })

  test('folderPattern', () => {
    expect(folderPattern('a/b')).toBe('a/b/**')
    expect(folderPattern('a/b', 'work')).toBe('work:a/b/**')
  })

  test('sharedShape replaces the one differing segment', () => {
    expect(sharedShape(['acme/round/web', 'acme/square/web'])).toBe('acme/*/web')
    expect(sharedShape(['acme/round/web', 'acme/square/api'])).toBeUndefined()
    expect(sharedShape(['acme/round/web', 'acme/web'])).toBeUndefined()
    expect(sharedShape(['acme/round/web'])).toBeUndefined()
  })
})

test('patternWithin is never more generous than Bun.Glob', () => {
  const patterns = [
    'a',
    'a/b',
    'a/b/c',
    'a/*',
    'a/**',
    'a/*/c',
    'a/b/*',
    'a/b/**',
    '*/c',
    '**/c',
    '**',
    'a/**/c',
    '*',
    '*/*',
    'a/app-*',
    'a/*/app-*',
    'x/**',
  ]
  const paths = [
    'a',
    'c',
    'a/b',
    'a/c',
    'a/app-x',
    'a/b/c',
    'a/x/c',
    'a/b/d',
    'a/b/c/d',
    'x/c',
    'x/y/c',
  ]
  for (const inner of patterns) {
    for (const outer of patterns) {
      if (!patternWithin(inner, outer)) continue
      for (const path of paths) {
        if (new Bun.Glob(inner).match(path)) {
          expect({ inner, outer, path, covered: new Bun.Glob(outer).match(path) }).toEqual({
            inner,
            outer,
            path,
            covered: true,
          })
        }
      }
    }
  }
})

test('globMatches agrees with Bun.Glob on repository paths', () => {
  const globs = [
    '**',
    '*',
    'acme/**',
    'acme/*',
    'acme/*/web',
    '**/web',
    'acme/**/web',
    '**/round/**',
    'acme/round/web',
    'acme/r?und/*',
    'acme/{round,square}/web',
    'acme/{round,sq{u,x}are}/**',
    'acme/[rs]*/web',
    'acme/[!r]*/web',
    'acme/web-*',
    '*/*/*',
    'a.b/*',
  ]
  const paths = [
    'acme',
    'acme/web',
    'acme/web-ui',
    'acme/round',
    'acme/round/web',
    'acme/square/web',
    'acme/sqxare/api',
    'acme/round/sub/web',
    'other/round/web',
    'web',
    'a.b/c',
    'axb/c',
  ]
  for (const glob of globs)
    for (const path of paths)
      expect({ glob, path, match: globMatches(glob, path) }).toEqual({
        glob,
        path,
        match: new Bun.Glob(glob).match(path),
      })
})
