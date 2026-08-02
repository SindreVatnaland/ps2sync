// File browser routes: list a directory, download a file, upload into a directory.
// All client paths go through resolveSafe() so they stay inside DATA_DIR.
import { createReadStream, createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { resolveSafe, listDir } from '../lib/files.js';

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  // Directory listing (JSON), hydrated by the Files page.
  app.get<{ Querystring: { path?: string } }>('/api/files', async (req, reply) => {
    try {
      return await listDir(req.query.path ?? '');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Stream a single file for download.
  app.get<{ Querystring: { path?: string } }>('/files/download', async (req, reply) => {
    let abs: string;
    try {
      abs = resolveSafe(req.query.path ?? '');
    } catch {
      return reply.code(400).send({ error: 'bad path' });
    }
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || st.isDirectory()) return reply.code(404).send({ error: 'not a file' });
    reply.header('content-disposition', `attachment; filename="${path.basename(abs).replace(/"/g, '')}"`);
    reply.header('content-length', String(st.size));
    reply.type('application/octet-stream');
    return reply.send(createReadStream(abs));
  });

  // Upload one or more files into ?dir= (relative, under DATA_DIR).
  app.post<{ Querystring: { dir?: string } }>('/files/upload', async (req, reply) => {
    let dir: string;
    try {
      dir = resolveSafe(req.query.dir ?? '');
    } catch {
      return reply.code(400).send({ error: 'bad target directory' });
    }
    await fsp.mkdir(dir, { recursive: true });
    const saved: string[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = path.basename(part.filename || '');
      if (!name) {
        part.file.resume();
        continue;
      }
      await pipeline(part.file, createWriteStream(path.join(dir, name)));
      saved.push(name);
    }
    if (saved.length === 0) return reply.code(400).send({ error: 'no files uploaded' });
    return { saved };
  });
}
