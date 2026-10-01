#!/usr/bin/env node
// @ts-check
/**
 * @file A static file server for the browser app, so no build step is needed to
 * try it. Serves the project directory on localhost only.
 *
 * It exists because browsers block ES-module imports over `file://`, which is the
 * single most likely thing to make someone conclude the app is broken when it is
 * not. `npm run app` and the URL it prints sidestep that entirely.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 8173);

/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);
  const requested = url.pathname === '/' ? '/app/index.html' : url.pathname;

  // Containment: resolve, then require the result to still be under root. A
  // request for /../../.ssh/id_rsa must not be served just because this is a
  // development tool.
  const target = resolve(root, '.' + normalize(requested));
  if (target !== root && !target.startsWith(root + sep)) {
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end('403 outside the project directory\n');
    return;
  }

  try {
    const body = await readFile(target);
    response.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end(`404 ${requested}\n`);
    } else {
      process.stderr.write(`serve: ${/** @type {Error} */ (error).message}\n`);
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('500 see the server log\n');
    }
  }
});

server.on('error', (error) => {
  process.stderr.write(`serve: ${error.message}\n`);
  if (/EADDRINUSE/.test(error.message)) {
    process.stderr.write(`hint: port ${port} is taken. Try PORT=8174 npm run app\n`);
  }
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`crest app on http://localhost:${port}/  (ctrl-c to stop)\n`);
});
