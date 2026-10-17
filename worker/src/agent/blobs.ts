// Content-addressed blob store ($NOPEAR_HOME/blobs/<sha256>), idempotent. Media type kept in a sidecar.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BinaryResult } from '@nopear/protocol';
import { randomId, sha256Hex } from '@nopear/core/crypto';

export class BlobStore {
  constructor(private readonly dir: string) {}

  async put(bytes: Uint8Array, mediaType: string): Promise<string> {
    const hash = sha256Hex(bytes);
    const file = join(this.dir, hash);
    if (!existsSync(file)) {
      await mkdir(this.dir, { recursive: true });
      // Sidecar first so a visible blob always has its media type; unique temp names avoid
      // collisions between concurrent puts of the same content.
      const typeTmp = `${file}.type.${randomId(8)}.tmp`;
      await writeFile(typeTmp, mediaType, 'utf8');
      await rename(typeTmp, `${file}.type`);
      const tmp = `${file}.${randomId(8)}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, file);
    }
    return hash;
  }

  async get(hash: string): Promise<BinaryResult | null> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const file = join(this.dir, hash);
    try {
      const bytes = new Uint8Array(await readFile(file));
      let mediaType = 'application/octet-stream';
      try { mediaType = (await readFile(`${file}.type`, 'utf8')).trim() || mediaType; } catch { /* no sidecar */ }
      return { bytes, mediaType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
  }
}
