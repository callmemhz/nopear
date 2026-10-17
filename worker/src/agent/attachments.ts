// Attachments → pi images (vision types) or files under <cwd>/.nopear-uploads with absolute paths appended.
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';
import { randomId } from '@nopear/core/crypto';
import { VISION_MEDIA_TYPES, type Attachment } from '@nopear/protocol';
import { toWebp } from './image-normalize';

export async function prepareAttachments(cwd: string, text: string, attachments: Attachment[] | undefined): Promise<{ text: string; images: ImageContent[] }> {
  const images: ImageContent[] = [];
  const paths: string[] = [];
  for (const a of attachments ?? []) {
    if (a.kind === 'image' && (VISION_MEDIA_TYPES as readonly string[]).includes(a.mediaType)) {
      // Every image reaches the model as WebP with a capped long side; an image the backend cannot
      // decode is passed through unchanged rather than dropped.
      const conv = await toWebp(a.dataBase64, a.mediaType);
      images.push(conv
        ? { type: 'image', data: conv.data, mimeType: conv.mimeType }
        : { type: 'image', data: a.dataBase64, mimeType: a.mediaType });
      continue;
    }
    const dir = join(cwd, '.nopear-uploads');
    await mkdir(dir, { recursive: true });
    let safe = basename(a.name || 'upload').replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
    if (!safe) safe = 'upload';
    // unique prefix: same-named uploads never overwrite each other
    const file = join(dir, `${Date.now().toString(36)}-${randomId(4).replace(/[^\w]/g, '')}-${safe}`);
    await writeFile(file, Buffer.from(a.dataBase64, 'base64'));
    paths.push(file);
  }
  const out = paths.length ? `${text}${text ? '\n\n' : ''}${paths.map((p) => `[附件] ${p}`).join('\n')}` : text;
  return { text: out, images };
}
