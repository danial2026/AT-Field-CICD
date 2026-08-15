// Builds the trimmed Monaco editor bundle into public/vendor/editor/.
//
//   npm run build:editor
//
// Outputs:
//   public/vendor/editor/editor-main.js     editor + API + languages (IIFE, sets window.monaco)
//   public/vendor/editor/editor-main.css    all editor widget styles (fonts inlined)
//   public/vendor/editor/editor.worker.js   classic web worker script
//
// The whole directory is committed to the repo so production servers and the
// Docker image do not need monaco-editor or esbuild installed.

import { build } from 'esbuild';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(here, '../public/vendor/editor');

mkdirSync(outdir, { recursive: true });

const shared = {
  bundle: true,
  format: 'iife',
  minify: true,
  sourcemap: false,
  target: ['chrome110', 'firefox110', 'safari15.5', 'edge110'],
  logLevel: 'info',
  loader: { '.ttf': 'file' },
};

await build({
  ...shared,
  entryPoints: [path.join(here, 'editor/editor-entry.js')],
  outfile: path.join(outdir, 'editor-main.js'),
});

await build({
  ...shared,
  entryPoints: [path.join(here, 'editor/worker-entry.js')],
  outfile: path.join(outdir, 'editor.worker.js'),
});

console.log('Built Monaco bundle into', outdir);