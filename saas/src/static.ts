import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.wasm': 'application/wasm',
};

/** Serve the web build (history-routing fallback to index.html) for GETs outside /api and /worker. */
export function registerStatic(app: FastifyInstance, webDir: string): void {
  const root = resolve(webDir);
  app.setNotFoundHandler(async (req, reply) => {
    const path = (req.url.split('?')[0] ?? '/');
    const isApi = path === '/api' || path.startsWith('/api/') || path === '/worker' || path.startsWith('/worker/');
    if (req.method !== 'GET' || isApi || !existsSync(join(root, 'index.html'))) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'not found' } });
    }
    let rel: string;
    try { rel = decodeURIComponent(path); } catch { rel = '/'; }
    const file = normalize(join(root, rel));
    const target = file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile() ? file : join(root, 'index.html');
    const type = TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
    const cache = target.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    if (type.startsWith('text/html')) {
      // Anti-clickjacking: the console (incl. the /claim confirm) must never render inside a frame.
      reply.header('x-frame-options', 'DENY').header('content-security-policy', "frame-ancestors 'none'");
    }
    return reply.header('content-type', type).header('cache-control', cache).send(await readFile(target));
  });
}
