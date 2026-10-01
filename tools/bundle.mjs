// @ts-check
/**
 * @file A minimal ES-module inliner, so the browser app can ship as one file.
 *
 * Browsers refuse cross-file ES-module imports over `file://`, so an app made of
 * modules needs either a server or a bundle. `tools/serve.mjs` provides the
 * server for development; this provides the bundle, which is what lets the result
 * be a single HTML file you can put on a USB stick or email to a classmate.
 *
 * It is not a general bundler and does not pretend to be. It assumes what is
 * actually true of this codebase: every import is a single-line, side-effect-free
 * named import of a local `.mjs` file, nothing is imported under an alias, and no
 * module uses `export default` or re-exports. Those assumptions are *checked*
 * rather than hoped for -- `inlineModules` throws on anything it does not
 * understand, so a future edit that breaks them fails the build instead of
 * silently producing a bundle that is missing a function.
 *
 * Splitting this out from `build-app.mjs` keeps it testable without touching the
 * filesystem: `test/bundle.test.mjs` drives it with in-memory sources.
 */

import { CrestError } from '../src/errors.mjs';

/** Matches a single-line named import of a relative module. */
const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*'(\.[^']*)'\s*;?\s*$/;
/** Matches any other import form, which this inliner refuses to guess at. */
const ANY_IMPORT_RE = /^\s*import\b/;
/** Top-level declarations, used to detect collisions once scopes are merged. */
const DECL_RE = /^export\s+(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/;
const PRIVATE_DECL_RE = /^(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/;

/**
 * Resolve a relative specifier against the importing module's key.
 *
 * Keys are POSIX-style paths relative to the project root, e.g. `src/fsrs.mjs`.
 *
 * @param {string} fromKey
 * @param {string} specifier
 * @returns {string}
 */
export function resolveKey(fromKey, specifier) {
  const parts = fromKey.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      if (parts.length === 0) {
        throw new CrestError(`${fromKey}: import "${specifier}" escapes the project root.`);
      }
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

/**
 * Strip the import and export keywords from one module's source.
 *
 * @param {string} key
 * @param {string} source
 * @returns {{body: string, deps: string[], declared: string[]}}
 */
export function rewriteModule(key, source) {
  /** @type {string[]} */
  const deps = [];
  /** @type {string[]} */
  const declared = [];
  /** @type {string[]} */
  const out = [];

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const named = IMPORT_RE.exec(line);
    if (named) {
      deps.push(resolveKey(key, named[2]));
      continue; // the imported bindings become siblings in the merged scope
    }
    // Prose inside a doc comment can begin with the word "import"; only treat a
    // line as code if it does not open with a comment marker.
    const trimmed = line.trimStart();
    const isComment =
      trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    if (ANY_IMPORT_RE.test(line) && !isComment) {
      throw new CrestError(
        `${key}:${i + 1}: this inliner only understands single-line named imports ` +
          `of local modules, and cannot handle: ${line.trim()}`,
        {
          hint:
            'Rewrite it as `import { a, b } from \'./module.mjs\';`, or exclude the module ' +
            'from the browser bundle.',
        },
      );
    }
    if (/^\s*export\s+(?:default|\*|\{)/.test(line)) {
      throw new CrestError(
        `${key}:${i + 1}: default exports, re-exports and export lists are not supported: ${line.trim()}`,
      );
    }
    const decl = DECL_RE.exec(line);
    if (decl) {
      declared.push(decl[1]);
      out.push(line.replace(/^export\s+/, ''));
      continue;
    }
    const privateDecl = PRIVATE_DECL_RE.exec(line);
    if (privateDecl) declared.push(privateDecl[1]);
    out.push(line);
  }
  return { body: out.join('\n'), deps, declared };
}

/**
 * Inline a module graph into one script, in dependency order.
 *
 * @param {Map<string, string>} sources Keyed by project-relative POSIX path.
 * @param {string} entryKey
 * @returns {string} a single module body, with no imports or exports left
 */
export function inlineModules(sources, entryKey) {
  if (!sources.has(entryKey)) {
    throw new CrestError(`no source supplied for the entry module ${entryKey}.`);
  }
  /** @type {Map<string, {body: string, deps: string[], declared: string[]}>} */
  const rewritten = new Map();
  for (const [key, source] of sources) rewritten.set(key, rewriteModule(key, source));

  /** @type {string[]} */
  const order = [];
  /** @type {Set<string>} */
  const done = new Set();
  /** @type {Set<string>} */
  const onStack = new Set();

  /** @param {string} key */
  const visit = (key) => {
    if (done.has(key)) return;
    if (onStack.has(key)) {
      throw new CrestError(
        `import cycle through ${key}. The merged scope would evaluate declarations ` +
          'out of order, so the cycle has to be broken in the source.',
      );
    }
    const module = rewritten.get(key);
    if (!module) {
      throw new CrestError(`no source supplied for ${key}, imported in the module graph.`);
    }
    onStack.add(key);
    for (const dep of module.deps) visit(dep);
    onStack.delete(key);
    done.add(key);
    order.push(key);
  };
  visit(entryKey);

  // Merging scopes means two modules may not declare the same top-level name.
  // Catching that here turns a confusing runtime failure into a build failure.
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const key of order) {
    for (const name of /** @type {any} */ (rewritten.get(key)).declared) {
      const previous = owner.get(name);
      if (previous !== undefined) {
        throw new CrestError(
          `"${name}" is declared at the top level of both ${previous} and ${key}. ` +
            'The bundle merges module scopes, so top-level names must be unique.',
        );
      }
      owner.set(name, key);
    }
  }

  const chunks = order.map((key) => {
    const body = /** @type {any} */ (rewritten.get(key)).body.trim();
    return `// ===== ${key} =====\n${body}`;
  });
  return chunks.join('\n\n');
}
