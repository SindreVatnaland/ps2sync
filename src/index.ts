// Boot: open the DB (DDL runs on import), ensure the data dirs, reconcile any jobs
// stranded by a crash, warm the serial catalogue in the background, then serve.
import './db/index.js'; // side effect: opens sqlite + runs CREATE TABLE IF NOT EXISTS
import { config } from './config.js';
import { ensureDirs } from './lib/paths.js';
import * as jobs from './lib/jobs.js';
import * as gamedb from './lib/gamedb.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  ensureDirs();
  await jobs.reconcile(); // re-queue non-terminal jobs, clear stale work dirs
  void gamedb.ensureDb(); // fire-and-forget: download the PS2 serial catalogue if stale

  const app = buildServer();
  await app.listen({ host: '0.0.0.0', port: config.PORT });
  app.log.info(`ps2sync listening on http://0.0.0.0:${config.PORT}`);
}

main().catch((err) => {
  console.error('fatal: failed to start', err);
  process.exit(1);
});
