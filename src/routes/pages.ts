// Server-rendered HTML pages. Each route renders a view into the shared layout.
// Only the Library page reads the DB; the rest are static shells that
// public/app.js hydrates by polling.
import type { FastifyInstance } from 'fastify';
import { asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { games } from '../db/schema.js';
import { renderPage } from '../ui/layout.js';
import { libraryView, addView, searchView, jobsView, guideView, storageView } from '../ui/views.js';

const HTML = 'text/html; charset=utf-8';

export async function pageRoutes(app: FastifyInstance): Promise<void> {
  // Home = storage card (top) + jobs + library, one page.
  app.get('/', async (_req, reply) => {
    const rows = db.select().from(games).orderBy(asc(games.console), asc(games.title)).all();
    reply.type(HTML);
    return renderPage('Library', 'library', storageView() + jobsView() + libraryView(rows));
  });

  app.get('/add', async (_req, reply) => {
    reply.type(HTML);
    return renderPage('Add', 'add', addView());
  });

  app.get('/search', async (_req, reply) => {
    reply.type(HTML);
    return renderPage('Search', 'search', searchView());
  });

  app.get('/guide', async (_req, reply) => {
    reply.type(HTML);
    return renderPage('Setup guide', 'guide', guideView());
  });
}
