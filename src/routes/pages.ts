// Server-rendered HTML pages. Each route renders a view into the shared layout.
// Only the Library page reads the DB; the rest are static shells that
// public/app.js hydrates by polling.
import type { FastifyInstance } from 'fastify';
import { asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { games } from '../db/schema.js';
import { renderPage } from '../ui/layout.js';
import { libraryView, addView, searchView, jobsView, guideView, storageView, appsView, filesView } from '../ui/views.js';

const HTML = 'text/html; charset=utf-8';

export async function pageRoutes(app: FastifyInstance): Promise<void> {
  // One page: Add (top) + storage + jobs + library. No hopping between pages.
  app.get('/', async (_req, reply) => {
    const rows = db.select().from(games).orderBy(asc(games.console), asc(games.title)).all();
    reply.type(HTML);
    return renderPage('Library', 'library', addView() + storageView() + jobsView() + libraryView(rows));
  });

  // Add is folded into home now; keep the path working for old bookmarks.
  app.get('/add', async (_req, reply) => reply.redirect('/'));

  app.get('/search', async (_req, reply) => {
    reply.type(HTML);
    return renderPage('Search', 'search', searchView());
  });

  app.get('/guide', async (_req, reply) => {
    reply.type(HTML);
    return renderPage('Setup guide', 'guide', guideView());
  });

  app.get('/apps', async (_req, reply) => {
    reply.type(HTML);
    return renderPage('Apps', 'apps', appsView());
  });

  app.get('/files', async (_req, reply) => {
    reply.type(HTML);
    return renderPage('Files', 'files', filesView());
  });
}
