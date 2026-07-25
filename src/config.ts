// Reads process.env into a typed, frozen `config`. No throwing on missing vars —
// every setting has a default so the app boots bare.
// ponytail: hand-rolled env parsing. Ceiling: no schema validation lib (zod/envalid).
// Upgrade path: swap the three parse helpers for a schema if the surface grows.

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return v === 'true' || v === '1' || v === 'yes';
}

function int(v: string | undefined, def: number, name: string): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`config: ${name} must be a number, got "${v}"`);
  return n;
}

function str(v: string | undefined, def: string): string {
  return v === undefined || v === '' ? def : v;
}

const env = process.env;

export const config = {
  // Root data dir (host bind mount). Holds DVD/ CD/ POPS/ incoming/ db/.
  DATA_DIR: str(env.DATA_DIR, '/data'),
  // HTTP listen port.
  PORT: int(env.PORT, 8080, 'PORT'),
  // Hard cap on a single uploaded file. Default 12 GiB — fits a PS2 DVD9 image.
  MAX_UPLOAD_BYTES: int(env.MAX_UPLOAD_BYTES, 12884901888, 'MAX_UPLOAD_BYTES'),
  // Hard cap on a single URL download. Default 10 GiB.
  MAX_DOWNLOAD_BYTES: int(env.MAX_DOWNLOAD_BYTES, 10737418240, 'MAX_DOWNLOAD_BYTES'),
  // Allow URL downloads resolving/redirecting to private IP ranges (SSRF risk).
  ALLOW_PRIVATE_URL_HOSTS: bool(env.ALLOW_PRIVATE_URL_HOSTS, false),
  // Shared secret. If set, required as bearer token / login cookie. Empty = open.
  AUTH_TOKEN: env.AUTH_TOKEN || undefined, // unset/empty = no auth
  LOG_LEVEL: str(env.LOG_LEVEL, 'info'),
} as const;

export type Config = typeof config;
