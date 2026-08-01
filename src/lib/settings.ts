// App-level settings (key/value) in SQLite. Currently just the server's LAN IP —
// shown in the setup guide as the SMB address OPL connects to. A bridged container
// can't detect the host's LAN IP itself, so the user sets it once (or it auto-fills
// from the browser when the UI is opened via that IP).
import { sqlite } from '../db/index.js';

const getStmt = sqlite.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = sqlite.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export function getServerLanIp(): string {
  return ((getStmt.get('server_lan_ip') as { value: string } | undefined)?.value ?? '').trim();
}

export function setServerLanIp(ip: string): void {
  setStmt.run('server_lan_ip', ip.trim());
}

// When on, a startup + 12h timer auto-installs the latest *minor* release of any
// installed app (major bumps stay notify-only). Default off.
export function getAppsAutoUpdate(): boolean {
  return (getStmt.get('apps_auto_update') as { value: string } | undefined)?.value === '1';
}
export function setAppsAutoUpdate(on: boolean): void {
  setStmt.run('apps_auto_update', on ? '1' : '0');
}

// Accept empty (clears it) or a plain IPv4 literal — OPL's SMB config wants an IP,
// not a hostname.
export function isValidLanIp(ip: string): boolean {
  const s = ip.trim();
  if (s === '') return true;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every((o) => Number(o) <= 255);
}
