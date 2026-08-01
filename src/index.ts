// Boot: open the DB (DDL runs on import), ensure the data dirs, reconcile any jobs
// stranded by a crash, rename any legacy raw-serial files to OPL disc-id form,
// warm the serial catalogue in the background, then serve.
import './db/index.js'; // side effect: opens sqlite + runs CREATE TABLE IF NOT EXISTS
import { config } from './config.js';
import { ensureDirs } from './lib/paths.js';
import * as jobs from './lib/jobs.js';
import * as gamedb from './lib/gamedb.js';
import { reconcileNames, reconcileImages } from './lib/place.js';
import { autoUpdateApps } from './lib/apps.js';
import { getAppsAutoUpdate } from './lib/settings.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  ensureDirs();
  await jobs.reconcile(); // re-queue non-terminal jobs, clear stale work dirs
  await reconcileNames(); // rename any legacy raw-serial files to OPL disc-id form
  await reconcileImages(); // cook any raw 2352-sector CD image left as a bad .iso
  void gamedb.ensureDb(); // fire-and-forget: download the PS2 serial catalogue if stale

  // Auto-update homebrew apps when the toggle is on: once now, then every 12h.
  // Reads the setting each run, so flipping it in the UI takes effect without a restart.
  const autoUpdate = (): void => {
    if (getAppsAutoUpdate()) void autoUpdateApps();
  };
  autoUpdate();
  setInterval(autoUpdate, 12 * 60 * 60 * 1000).unref();

  const app = buildServer();
  await app.listen({ host: '0.0.0.0', port: config.PORT });
  app.log.info(`ps2sync listening on http://0.0.0.0:${config.PORT}`);
}

main().catch((err) => {
  console.error('fatal: failed to start', err);
  process.exit(1);
});
