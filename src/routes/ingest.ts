// Ingest routes: file upload and URL add. Uploads stream straight to disk (never
// buffered); both create a job and hand off to the pipeline, then redirect home.
import { createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { incomingJobDir } from '../lib/paths.js';
import { acceptedExtension } from '../lib/ingest.js';
import * as jobs from '../lib/jobs.js';
import type { Console, Media } from '../types.js';

// The Add page's single console/media dropdown, plus the raw console/media fields.
// 'target' is the UI's convenience value ('' | 'ps2-dvd' | 'ps2-cd' | 'ps1');
// explicit console/media are honoured too. Anything unrecognised => auto-detect.
interface OverrideFields {
  target?: string;
  console?: string;
  media?: string;
}

function parseOverride(f: OverrideFields): jobs.JobOverrides {
  switch (f.target) {
    case 'ps2-dvd':
      return { console: 'ps2', media: 'dvd' };
    case 'ps2-cd':
      return { console: 'ps2', media: 'cd' };
    case 'ps1':
      return { console: 'ps1', media: 'pops' };
  }
  const o: jobs.JobOverrides = {};
  if (f.console === 'ps1' || f.console === 'ps2') o.console = f.console as Console;
  if (f.media === 'dvd' || f.media === 'cd' || f.media === 'pops') o.media = f.media as Media;
  return o;
}

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  // Multipart upload. Iterate parts so the file streams to disk while we also read
  // the override fields (field order doesn't matter — we run the pipeline after the loop).
  app.post('/upload', async (req, reply) => {
    let job: ReturnType<typeof jobs.createUploadJob> | undefined;
    let rejected: string | undefined;
    const fields: OverrideFields = {};

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        // Only the first accepted file becomes the job; drain anything else.
        if (job || !acceptedExtension(part.filename)) {
          if (!job && !acceptedExtension(part.filename)) rejected = `unsupported file type: ${part.filename}`;
          part.file.resume(); // must consume the stream or the request hangs
          continue;
        }
        job = jobs.createUploadJob(part.filename);
        const dir = incomingJobDir(job.id);
        await fsp.mkdir(dir, { recursive: true });
        const dest = path.join(dir, path.basename(part.filename) || 'upload.bin');
        await pipeline(part.file, createWriteStream(dest));
      } else if (part.fieldname === 'target' || part.fieldname === 'console' || part.fieldname === 'media') {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!job) {
      return reply.code(400).send({ error: rejected ?? 'no file was uploaded' });
    }

    // Fire the pipeline in the background (identify -> dedupe -> [ps1 convert] -> place).
    void jobs.runJob(job.id, parseOverride(fields));
    return reply.redirect('/');
  });

  // URL add. formbody { url, console?, media?, target? }. createUrlJob inserts the
  // job and kicks the pipeline itself (it runs the download).
  app.post('/url', async (req, reply) => {
    const body = (req.body ?? {}) as OverrideFields & { url?: string };
    const url = (body.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return reply.code(400).send({ error: 'a direct http(s) URL is required' });
    }
    jobs.createUrlJob(url, parseOverride(body));
    return reply.redirect('/');
  });
}
