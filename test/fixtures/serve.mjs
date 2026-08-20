#!/usr/bin/env node
/*
 * test/fixtures/serve.mjs
 *
 * A tiny static file server for the test fixtures. Serves the repo root so the
 * harness and content scripts can load via `/lib/...`, `/content/...`, and the
 *  synthesized media via `/test/.fixtures/current/media.webm`.
 *
 * Usage:
 *   node test/fixtures/serve.mjs 8123            # CORS headers ON (default)
 *   node test/fixtures/serve.mjs 8124 --no-cors  # no CORS headers
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function contentType(fp) {
  const ext = path.extname(fp).toLowerCase();
  const table = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.gif': 'image/gif',
    '.json': 'application/json',
  };
  return table[ext] || 'application/octet-stream';
}

export function startServer({ port = 8123, cors = true, root = ROOT, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (urlPath === '/') urlPath = '/test/fixtures/harness.html';
      if (urlPath === '/watch' || urlPath === '/watch/') urlPath = '/test/fixtures/harness.html';
      const fp = path.normalize(path.join(root, urlPath));
      if (!fp.startsWith(root) || !existsSync(fp)) {
        res.writeHead(404).end('not found');
        return;
      }
      if (cors) res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', contentType(fp));
      res.end(await readFile(fp));
    } catch (err) {
      res.writeHead(500).end(String(err && err.message));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`[fixture server] http://${host}:${port} root=${root} cors=${cors}`);
      resolve(server);
    });
  });
}

/* CLI entrypoint */
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.argv[2] || '8123', 10);
  const cors = !process.argv.includes('--no-cors');
  startServer({ port, cors }).then((server) => {
    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}