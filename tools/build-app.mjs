#!/usr/bin/env node
// @ts-check
/**
 * @file Build `dist/crest.html`: the whole app in one file, no server needed.
 *
 * Walks the import graph from `app/ui.mjs`, inlines it with `tools/bundle.mjs`,
 * and substitutes the result for the `<script src>` tag in `app/index.html`.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { inlineModules, rewriteModule } from './bundle.mjs';
import { CrestError } from '../src/errors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'app/ui.mjs';
const SCRIPT_TAG = '<script type="module" src="./ui.mjs"></script>';

/**
 * Read the entry module and everything it transitively imports.
 *
 * @param {string} entryKey
 * @returns {Promise<Map<string, string>>}
 */
async function collectSources(entryKey) {
  /** @type {Map<string, string>} */
  const sources = new Map();
  /** @type {string[]} */
  const queue = [entryKey];
  while (queue.length > 0) {
    const key = /** @type {string} */ (queue.shift());
    if (sources.has(key)) continue;
    let text;
    try {
      text = await readFile(resolve(root, key), 'utf8');
    } catch (error) {
      throw new CrestError(`cannot read ${key}: ${/** @type {Error} */ (error).message}`, {
        cause: error,
      });
    }
    sources.set(key, text);
    for (const dep of rewriteModule(key, text).deps) {
      if (!sources.has(dep)) queue.push(dep);
    }
  }
  return sources;
}

async function main() {
  const sources = await collectSources(ENTRY);
  const bundle = inlineModules(sources, ENTRY);

  const htmlPath = resolve(root, 'app/index.html');
  const html = await readFile(htmlPath, 'utf8');
  if (!html.includes(SCRIPT_TAG)) {
    throw new CrestError(
      `app/index.html no longer contains the expected script tag:\n  ${SCRIPT_TAG}`,
      { hint: 'The build substitutes that exact line; update SCRIPT_TAG in tools/build-app.mjs.' },
    );
  }

  // The bundle is JavaScript inside an HTML document, so a literal `</script>`
  // anywhere in it -- in a string or a comment -- would end the element early.
  // Nothing in this codebase contains one, but checking is cheaper than debugging
  // a blank page.
  if (bundle.includes('</script')) {
    throw new CrestError(
      'the bundled source contains a literal "</script", which would terminate the ' +
        'inline script element. Split it (for example as "<" + "/script") at the source.',
    );
  }

  const inlined = html.replace(
    SCRIPT_TAG,
    `<script type="module">\n${bundle}\n</script>`,
  );
  const outDir = resolve(root, 'dist');
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, 'crest.html');
  await writeFile(outPath, inlined, 'utf8');

  const kb = (inlined.length / 1024).toFixed(0);
  process.stderr.write(
    `wrote dist/crest.html (${kb} kB, ${sources.size} modules inlined)\n` +
      'Open it directly in a browser; it needs no server and makes no network requests.\n',
  );
}

main().catch((error) => {
  if (error instanceof CrestError) {
    process.stderr.write(`build failed: ${error.message}\n`);
    if (error.hint) process.stderr.write(`hint: ${error.hint}\n`);
  } else {
    process.stderr.write(`build failed: ${/** @type {Error} */ (error).stack}\n`);
  }
  process.exitCode = 1;
});
