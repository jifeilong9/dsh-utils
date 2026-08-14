/**
 * Build the dsh-utils client bundle.
 *
 * The web server serves exactly one file per plugin (/plugins/dsh-utils/client.js),
 * so the client half is one CJS bundle wrapped in the ModuleLoader factory
 * handshake; react / react-dom / @deepseek-ai/* stay external (the app's
 * module system provides them), while highlight.js and the theme CSS are
 * bundled in. The file-icon dataset (gen-icons.mjs) is embedded into
 * src/client.js before bundling.
 *
 * Usage: node build.mjs
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

await build({
  entryPoints: ['src/client.js'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: false,
  // The entry is CJS wrapped by the ModuleLoader banner; without this,
  // esbuild's tree shaking drops the entry's exports (module.exports is
  // invisible to it once the banner declares module/exports).
  treeShaking: false,
  external: ['react', 'react-dom/client', '@deepseek-ai/*'],
  loader: { '.css': 'text' },
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-utils', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})
