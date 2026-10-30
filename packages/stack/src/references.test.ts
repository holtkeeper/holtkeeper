import { expect, test } from 'bun:test'

import {
  ciIncludes,
  dockerfileReferences,
  latestTag,
  nameVersion,
  parseImageRef,
  tagVersion,
  variantFamily,
  yamlReferences,
} from './index.ts'

test('parses image references with Docker Hub defaults', () => {
  expect(parseImageRef('node:22-alpine')).toEqual({
    registry: 'docker.io',
    repository: 'library/node',
    tag: '22-alpine',
  })
  expect(parseImageRef('ghcr.io/acme/base:1.2@sha256:abc')).toEqual({
    registry: 'ghcr.io',
    repository: 'acme/base',
    tag: '1.2',
    digest: 'sha256:abc',
  })
  expect(parseImageRef('localhost:5000/tools/ci')).toEqual({
    registry: 'localhost:5000',
    repository: 'tools/ci',
  })
  expect(parseImageRef('$CI_REGISTRY_IMAGE:latest')).toBeUndefined()
  expect(parseImageRef('Not An Image')).toBeUndefined()
})

test('splits tags into versions and variants', () => {
  expect(tagVersion('22.11.0-alpine3.20')).toEqual({ version: '22.11.0', variant: 'alpine3.20' })
  expect(tagVersion('v1.27')).toEqual({ version: '1.27' })
  expect(tagVersion('lts-alpine')).toEqual({ variant: 'lts-alpine' })
  expect(tagVersion('latest')).toEqual({})
  expect(variantFamily('alpine3.20')).toBe('alpine')
  expect(variantFamily('slim-bookworm')).toBe('slim-bookworm')
})

test('reads FROM lines with ARG defaults and skips stages and scratch', () => {
  const dockerfile = [
    'ARG NODE_VERSION=22.11',
    'ARG BASE="alpine:3.20"',
    'FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build',
    'RUN npm ci \\',
    '  && npm run build',
    'FROM build AS test',
    'FROM ${BASE}',
    'FROM scratch',
    'FROM $UNKNOWN_IMAGE',
  ].join('\n')
  expect(dockerfileReferences(dockerfile)).toEqual({
    references: [
      { type: 'image', ref: 'node:22.11-alpine' },
      { type: 'image', ref: 'alpine:3.20' },
    ],
    unresolved: ['$UNKNOWN_IMAGE'],
  })
})

test('finds images in GitLab CI, compose and Helm values', () => {
  const gitlab = Bun.YAML.parse(`
variables:
  NODE_IMAGE: node:20
default:
  image: $NODE_IMAGE
test:
  image:
    name: golang:1.23
    entrypoint: [""]
  services:
    - postgres:16
    - name: redis:7.2-alpine
      alias: cache
`)
  expect(yamlReferences(gitlab).references.map((reference) => reference)).toEqual([
    { type: 'image', ref: 'node:20' },
    { type: 'image', ref: 'golang:1.23' },
    { type: 'image', ref: 'postgres:16' },
    { type: 'image', ref: 'redis:7.2-alpine' },
  ])
  const compose = Bun.YAML.parse(`
services:
  db:
    image: postgres:15.4
  app:
    build: .
`)
  expect(yamlReferences(compose).references).toEqual([{ type: 'image', ref: 'postgres:15.4' }])
  const values = Bun.YAML.parse(`
image:
  registry: ghcr.io
  repository: acme/api
  tag: 2.4.1
`)
  expect(yamlReferences(values).references).toEqual([
    { type: 'image', ref: 'ghcr.io/acme/api:2.4.1' },
  ])
})

test('reads GitHub Actions setup versions, expanding matrices', () => {
  const workflow = Bun.YAML.parse(`
jobs:
  test:
    strategy:
      matrix:
        node: [20, 22]
    container: node:22-bookworm
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0
      - uses: docker://alpine:3.19
`)
  expect(yamlReferences(workflow)).toEqual({
    references: [
      { type: 'image', ref: 'node:22-bookworm' },
      { type: 'tool', tool: 'node', declared: '20' },
      { type: 'tool', tool: 'node', declared: '22' },
      { type: 'tool', tool: 'pnpm', declared: '9.12.0' },
      { type: 'image', ref: 'alpine:3.19' },
    ],
    unresolved: [],
  })
})

test('picks the newest release tag in the variant family usages prefer', () => {
  const tags = ['1.26.2', '1.27.3-alpine', '1.27.3', '1.28.0-rc1', 'latest', 'mainline-alpine']
  expect(latestTag(tags, ['alpine'])).toBe('1.27.3')
  expect(latestTag(['1.25-alpine', '1.27-alpine'], ['alpine'])).toBe('1.27')
  expect(latestTag(['latest'], [''])).toBeUndefined()
})

test('expands variables with GitLab precedence: CI over job over top level over inherited', () => {
  const document = Bun.YAML.parse(`
variables:
  BASE: node
  TAG: '20'
build:
  variables:
    TAG: '22'
  image: $BASE:$TAG
test:
  image: \${REGISTRY}/tools:\${TOOLS_TAG:-1.0}
lint:
  image: $IMAGE
`)
  expect(
    yamlReferences(document, {
      inherited: { BASE: 'ignored', REGISTRY: 'registry.example.com/$GROUP' },
      ci: { GROUP: 'acme', IMAGE: 'alpine:3.20' },
    }).references,
  ).toEqual([
    { type: 'image', ref: 'ignored:22' },
    { type: 'image', ref: 'registry.example.com/acme/tools:1.0' },
    { type: 'image', ref: 'alpine:3.20' },
  ])
})

test('lists GitLab includes it can follow', () => {
  const document = Bun.YAML.parse(`
include:
  - local: /ci/build.yml
  - 'ci/test.yml'
  - project: acme/ci-templates
    ref: v2
    file: [node.yml, /docker.yml]
  - remote: https://example.com/ci.yml
  - template: Auto-DevOps.gitlab-ci.yml
`)
  expect(ciIncludes(document)).toEqual({
    includes: [
      { type: 'local', file: 'ci/build.yml' },
      { type: 'local', file: 'ci/test.yml' },
      { type: 'project', project: 'acme/ci-templates', file: 'node.yml', ref: 'v2' },
      { type: 'project', project: 'acme/ci-templates', file: 'docker.yml', ref: 'v2' },
    ],
    skipped: ['https://example.com/ci.yml', 'Auto-DevOps.gitlab-ci.yml'],
  })
})

test('reads tool versions written into image names', () => {
  expect(nameVersion('acme/infrastructure/baseimages/bun-1-3-slim')).toEqual({
    tool: 'bun',
    version: '1.3',
    variant: 'slim',
  })
  expect(nameVersion('baseimages/node-22-alpine-build-tools')).toEqual({
    tool: 'node',
    version: '22',
    variant: 'alpine-build-tools',
  })
  expect(nameVersion('acme/python3.12')).toEqual({ tool: 'python', version: '3.12' })
  expect(nameVersion('library/node')).toBeUndefined()
  expect(nameVersion('prom/node-exporter')).toBeUndefined()
})
