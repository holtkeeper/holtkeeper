import { expect, test } from 'bun:test'

import { sourceOrigin } from './origin.ts'

test.each([
  [
    'node_modules/react/index.js',
    { package: 'react', installPath: 'node_modules/react', path: 'index.js' },
  ],
  [
    'node_modules/@tanstack/react-query/build/index.js',
    {
      package: '@tanstack/react-query',
      installPath: 'node_modules/@tanstack/react-query',
      path: 'build/index.js',
    },
  ],
  [
    'node_modules/a/node_modules/lodash/map.js',
    { package: 'lodash', installPath: 'node_modules/a/node_modules/lodash', path: 'map.js' },
  ],
  [
    'node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/map.js',
    {
      package: 'lodash',
      version: '4.17.21',
      installPath: 'node_modules/.pnpm/lodash@4.17.21/node_modules/lodash',
      path: 'map.js',
    },
  ],
  [
    'node_modules/.pnpm/@scope+ui@2.0.0_react@18.3.1/node_modules/@scope/ui/dist/x.js',
    {
      package: '@scope/ui',
      version: '2.0.0',
      installPath: 'node_modules/.pnpm/@scope+ui@2.0.0_react@18.3.1/node_modules/@scope/ui',
      path: 'dist/x.js',
    },
  ],
  [
    'webpack://my-app/./node_modules/react-dom/cjs/react-dom.production.min.js',
    {
      package: 'react-dom',
      installPath: 'node_modules/react-dom',
      path: 'cjs/react-dom.production.min.js',
    },
  ],
  ['webpack://my-app/./src/App.tsx', { package: '(app)', path: 'src/App.tsx' }],
  [
    'webpack://my-app/webpack/runtime/chunk loaded',
    { package: 'webpack', path: 'webpack/runtime/chunk loaded' },
  ],
  ['\0vite/preload-helper.js', { package: 'vite', path: 'vite/preload-helper.js' }],
  ['vite/modulepreload-polyfill.js', { package: 'vite', path: 'vite/modulepreload-polyfill.js' }],
  ['\0commonjsHelpers.js', { package: '(virtual)', path: 'commonjsHelpers.js' }],
  ['src/main.ts?vue&type=script', { package: '(app)', path: 'src/main.ts' }],
  [
    '../../packages/ui/src/button.tsx',
    { package: '(app)', path: '../../packages/ui/src/button.tsx' },
  ],
])('%s', (source, expected) => {
  expect(sourceOrigin(source)).toEqual(expected)
})
