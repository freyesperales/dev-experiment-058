// @ts-check
/**
 * @file The browser bundle.
 *
 * Two jobs. First, check the inliner's own rules on small in-memory inputs.
 * Second -- and this is the part that matters -- build the real bundle from the
 * real app entry point and *evaluate it*, then call the planner through it. That
 * proves the single-file artifact is valid JavaScript whose numbers match the
 * module path, which is as far as this can be verified without driving a browser.
 * The remaining untested surface is `app/ui.mjs`'s DOM calls, and the README says
 * so plainly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineModules, rewriteModule, resolveKey } from '../tools/bundle.mjs';
import { planCollection } from '../src/plan.mjs';
import { synthesiseCollection } from '../src/synth.mjs';
import { CrestError } from '../src/errors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('resolveKey walks relative specifiers', () => {
  assert.equal(resolveKey('app/ui.mjs', '../src/plan.mjs'), 'src/plan.mjs');
  assert.equal(resolveKey('src/plan.mjs', './fsrs.mjs'), 'src/fsrs.mjs');
  assert.equal(resolveKey('src/a/b.mjs', '../c.mjs'), 'src/c.mjs');
  assert.throws(() => resolveKey('a.mjs', '../../x.mjs'), /escapes the project root/);
});

test('rewriteModule strips imports and the export keyword', () => {
  const { body, deps, declared } = rewriteModule(
    'src/x.mjs',
    [
      "import { a } from './y.mjs';",
      'export const b = 1;',
      'const c = 2;',
      'export function d() { const inner = 3; return inner; }',
      'export class E {}',
    ].join('\n'),
  );
  assert.deepEqual(deps, ['src/y.mjs']);
  assert.deepEqual(declared, ['b', 'c', 'd', 'E']);
  assert.ok(!body.includes('import'));
  assert.ok(!/^export/m.test(body));
  assert.ok(body.includes('const b = 1;'));
  // An indented declaration inside a function is not a top-level name.
  assert.ok(!declared.includes('inner'));
});

test('unsupported module syntax fails the build rather than being guessed at', () => {
  assert.throws(
    () => rewriteModule('src/x.mjs', "import def from './y.mjs';"),
    /only understands single-line named imports/,
  );
  assert.throws(
    () => rewriteModule('src/x.mjs', "import * as ns from './y.mjs';"),
    /only understands single-line named imports/,
  );
  assert.throws(
    () => rewriteModule('src/x.mjs', 'export default 1;'),
    /default exports, re-exports and export lists are not supported/,
  );
  assert.throws(
    () => rewriteModule('src/x.mjs', "export { a } from './y.mjs';"),
    /not supported/,
  );
});

test('the word "import" inside a doc comment is not mistaken for code', () => {
  const source = [
    '/**',
    ' * import is a word that appears in prose.',
    ' */',
    '// import something, eventually',
    'export const ok = 1;',
  ].join('\n');
  assert.doesNotThrow(() => rewriteModule('src/x.mjs', source));
});

test('modules are emitted in dependency order', () => {
  const sources = new Map([
    ['src/entry.mjs', "import { b } from './b.mjs';\nexport const entry = b + 1;"],
    ['src/b.mjs', "import { c } from './c.mjs';\nexport const b = c * 2;"],
    ['src/c.mjs', 'export const c = 5;'],
  ]);
  const bundle = inlineModules(sources, 'src/entry.mjs');
  assert.ok(bundle.indexOf('src/c.mjs') < bundle.indexOf('src/b.mjs'));
  assert.ok(bundle.indexOf('src/b.mjs') < bundle.indexOf('src/entry.mjs'));
});

test('an import cycle is reported, not silently mis-ordered', () => {
  const sources = new Map([
    ['src/a.mjs', "import { b } from './b.mjs';\nexport const a = b;"],
    ['src/b.mjs', "import { a } from './a.mjs';\nexport const b = a;"],
  ]);
  assert.throws(() => inlineModules(sources, 'src/a.mjs'), /import cycle/);
});

test('a top-level name declared in two modules is reported', () => {
  const sources = new Map([
    ['src/a.mjs', "import { x } from './b.mjs';\nexport const dup = 1;"],
    ['src/b.mjs', 'export const dup = 2;\nexport const x = 3;'],
  ]);
  assert.throws(
    () => inlineModules(sources, 'src/a.mjs'),
    /"dup" is declared at the top level of both/,
  );
});

test('a missing module is named', () => {
  const sources = new Map([['src/a.mjs', "import { b } from './gone.mjs';\nexport const a = 1;"]]);
  assert.throws(() => inlineModules(sources, 'src/a.mjs'), /no source supplied for src\/gone.mjs/);
  assert.throws(() => inlineModules(new Map(), 'src/a.mjs'), /entry module/);
});

/**
 * Read the real app's module graph off disk, exactly as the build does.
 * @returns {Promise<Map<string, string>>}
 */
async function realSources() {
  /** @type {Map<string, string>} */
  const sources = new Map();
  /** @type {string[]} */
  const queue = ['app/ui.mjs'];
  while (queue.length > 0) {
    const key = /** @type {string} */ (queue.shift());
    if (sources.has(key)) continue;
    const text = await readFile(resolve(root, key), 'utf8');
    sources.set(key, text);
    for (const dep of rewriteModule(key, text).deps) if (!sources.has(dep)) queue.push(dep);
  }
  return sources;
}

test('the real app bundles cleanly and pulls in the whole engine', async () => {
  const sources = await realSources();
  const bundle = inlineModules(sources, 'app/ui.mjs');
  assert.ok(sources.size >= 9, `only ${sources.size} modules were reached`);
  for (const expected of [
    'src/errors.mjs', 'src/fsrs.mjs', 'src/value.mjs', 'src/plans.mjs',
    'src/solver.mjs', 'src/simulate.mjs', 'src/viewmodel.mjs', 'src/plan.mjs',
    'src/collection.mjs', 'src/synth.mjs', 'src/csv.mjs',
  ]) {
    assert.ok(sources.has(expected), `${expected} was not reached from the app entry point`);
  }
  assert.ok(!/^\s*import\s/m.test(bundle), 'an import survived into the bundle');
  assert.ok(!/^export\s/m.test(bundle), 'an export survived into the bundle');
  // A literal </script> would truncate the inline element in the generated HTML.
  assert.ok(!bundle.includes('</script'), 'the bundle would close its own script element');
});

test('the bundled engine computes the same plan as the module path', async () => {
  // The real check: evaluate the bundle and run a plan through it. `document` is
  // undefined under Node, which is exactly why `app/ui.mjs` guards its auto-attach
  // on `typeof document !== 'undefined'` -- so the bundle is importable here.
  const sources = await realSources();
  const bundle = inlineModules(sources, 'app/ui.mjs');
  const dataUrl =
    'data:text/javascript;base64,' +
    Buffer.from(`${bundle}\nexport { planCollection, synthesiseCollection };`, 'utf8').toString(
      'base64',
    );
  /** @type {any} */
  const bundled = await import(dataUrl);

  assert.equal(typeof bundled.planCollection, 'function');
  const options = {
    cards: synthesiseCollection({ count: 50, seed: 17 }),
    examInDays: 7,
    budgetMinutes: 8,
    startDate: '2026-10-01',
    trials: 0,
    iterations: 25,
  };
  const viaBundle = bundled.planCollection({
    ...options,
    cards: bundled.synthesiseCollection({ count: 50, seed: 17 }),
  });
  const viaModules = planCollection(options);

  assert.equal(
    /** @type {any} */ (viaBundle.viewModel.summary).expectedRecall.planned,
    /** @type {any} */ (viaModules.viewModel.summary).expectedRecall.planned,
    'the bundle and the modules disagree about the plan value',
  );
  assert.deepEqual(
    viaBundle.viewModel.perCard.map((/** @type {any} */ c) => [c.cardId, c.days]),
    viaModules.viewModel.perCard.map((/** @type {any} */ c) => [c.cardId, c.days]),
    'the bundle and the modules produced different schedules',
  );
});

test('index.html still contains the exact tag the build substitutes', async () => {
  const html = await readFile(resolve(root, 'app/index.html'), 'utf8');
  assert.ok(
    html.includes('<script type="module" src="./ui.mjs"></script>'),
    'the script tag tools/build-app.mjs replaces has changed; the build would fail',
  );
  // Every element the UI writes into must exist, or the app throws on first render.
  for (const id of [
    'start-date', 'exam-date', 'budget', 'max-reviews', 'trials', 'params',
    'drop', 'file', 'plan-button', 'status', 'results', 'headline', 'outcome',
    'disposition', 'days', 'advice', 'cards', 'abandoned', 'notes',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `app/index.html is missing #${id}`);
  }
});

test('the UI module references no element id that index.html lacks', async () => {
  const [ui, html] = await Promise.all([
    readFile(resolve(root, 'app/ui.mjs'), 'utf8'),
    readFile(resolve(root, 'app/index.html'), 'utf8'),
  ]);
  const referenced = new Set(
    [...ui.matchAll(/\b(?:el|input)\('([a-z-]+)'\)/g)].map((m) => m[1]),
  );
  assert.ok(referenced.size > 10, `only found ${referenced.size} element references`);
  for (const id of referenced) {
    assert.ok(html.includes(`id="${id}"`), `app/ui.mjs reads #${id}, which index.html lacks`);
  }
});

test('CrestError hints survive into the bundle for the UI to display', async () => {
  const sources = await realSources();
  const bundle = inlineModules(sources, 'app/ui.mjs');
  assert.ok(bundle.includes('class CrestError'));
  assert.ok(bundle.includes('this.hint'));
  assert.ok(CrestError.prototype instanceof Error);
});
