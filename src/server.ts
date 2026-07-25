// Fastify assembly: static files, streamed multipart, form bodies, cookies,
// an optional shared-token auth gate, and the route modules.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { renderPage } from './ui/layout.js';
import { loginView } from './ui/views.js';
import { pageRoutes } from './routes/pages.js';
import { ingestRoutes } from './routes/ingest.js';
import { apiRoutes } from './routes/api.js';

const HTML = 'text/html; charset=utf-8';
// public/ sits next to the compiled output (dist/../public) and next to src/ in dev.
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  // Streamed multipart uploads — never buffer a multi-GB file. The routes consume
  // req.parts() and pipe straight to disk. fileSize effectively off.
  app.register(multipart, { limits: { fileSize: 1024 ** 4 } });
  app.register(formbody);
  app.register(cookie);
  app.register(fastifyStatic, { root: publicDir, prefix: '/static/' });

  // Optional single shared-token auth. /health and /static are exempt.
  // ponytail: plain string compare (no constant-time), token in a plaintext cookie.
  //   Ceiling: fine for a trusted LAN behind a reverse proxy. Upgrade path: real
  //   sessions + timing-safe compare if this ever faces the internet directly.
  if (config.AUTH_TOKEN) {
    const token = config.AUTH_TOKEN;

    app.addHook('onRequest', async (req, reply) => {
      const url = req.url.split('?')[0];
      if (url === '/health' || url === '/login' || url.startsWith('/static/')) return;

      const authz = req.headers.authorization;
      const bearer = authz?.startsWith('Bearer ') ? authz.slice(7) : undefined;
      if (bearer === token || req.cookies?.auth === token) return;

      const wantsHtml = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
      if (wantsHtml) return reply.redirect('/login');
      return reply.code(401).send({ error: 'unauthorized' });
    });

    app.get('/login', async (_req, reply) => {
      reply.type(HTML);
      return renderPage('Sign in', '', loginView());
    });

    app.post('/login', async (req, reply) => {
      const submitted = ((req.body ?? {}) as { token?: string }).token;
      if (submitted && submitted === token) {
        reply.setCookie('auth', token, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 30,
        });
        return reply.redirect('/');
      }
      reply.type(HTML).code(401);
      return renderPage('Sign in', '', loginView('Wrong token — try again.'));
    });
  }

  app.register(pageRoutes);
  app.register(ingestRoutes);
  app.register(apiRoutes);

  return app;
}
