// Shared "files → Attachment[]" pipeline for the 📎 picker, clipboard paste and drag-and-drop.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { Attachment } from '@nopear/protocol';
import { attachmentBytes, checkAttachmentTotal, fileToAttachment } from './compress';

export const TOTAL_TOO_LARGE = '附件总大小超过 45MB，请减少附件';

/** Minimal shape of a DataTransfer we read (the clipboard's or a drop's). */
interface TransferLike {
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
  files?: ArrayLike<File> | null;
  types?: ArrayLike<string> | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const extOf = (mediaType: string) => {
  const sub = mediaType.split('/')[1]?.split('+')[0] || 'png';
  return sub === 'jpeg' ? 'jpg' : sub;
};
/**
 * Clipboard screenshots arrive without a meaningful name (empty, or the browser's generic `image.png`):
 * give them a readable one, `粘贴图片-<HHmmss>.<ext>`.
 */
export function namePastedFile(file: File, now: Date = new Date()): File {
  const generic = !file.name || (file.type.startsWith('image/') && /^image\.\w+$/i.test(file.name));
  if (!generic) return file;
  const type = file.type || 'image/png';
  const name = `粘贴图片-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${extOf(type)}`;
  return new File([file], name, { type, lastModified: file.lastModified });
}

/** Files carried by a clipboard/drop transfer (`items` of kind 'file', falling back to `files`). */
export function transferFiles(dt: TransferLike | null | undefined): File[] {
  if (!dt) return [];
  const items = dt.items ? Array.from(dt.items) : [];
  if (items.length) return items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
  return dt.files ? Array.from(dt.files) : [];
}
const hasFiles = (dt: TransferLike | null | undefined) => !!dt?.types && Array.from(dt.types).includes('Files');

/** Convert files (images compressed to budget) and enforce the 45MB total against what's already attached. */
export async function prepareAttachments(files: File[], current: Attachment[], convert: (f: File) => Promise<Attachment> = fileToAttachment): Promise<Attachment[]> {
  const added = await Promise.all(files.map((f) => convert(f)));
  if (!checkAttachmentTotal([...current, ...added].map(attachmentBytes))) throw new Error(TOTAL_TOO_LARGE);
  return added;
}

export interface PasteAttachmentsOptions {
  current: Attachment[];
  onAdd: (a: Attachment[]) => void;
  onError: (message: string) => void;
}

/**
 * Paste / drop / pick → attachments. `onPaste` only intercepts pastes that carry files; a paste that also carries text
 * is left to the browser so the text still lands in the textarea (a textarea ignores the file part by itself).
 * Spread `dropProps` on the drop area and use `dragging` for its highlight.
 */
export function usePasteAttachments({ current, onAdd, onError }: PasteAttachmentsOptions) {
  const latest = useRef({ current, onAdd, onError });
  useEffect(() => { latest.current = { current, onAdd, onError }; });
  const [pending, setPending] = useState(0);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setPending((n) => n + 1);
    try {
      const added = await prepareAttachments(files, latest.current.current);
      latest.current.onAdd(added);
    } catch (e) {
      latest.current.onError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending((n) => n - 1);
    }
  }, []);

  const onPaste = useCallback((e: ClipboardEvent<HTMLElement>) => {
    const dt = e.clipboardData;
    const files = transferFiles(dt);
    if (files.length === 0) return; // plain text paste: untouched
    if (!dt.getData('text/plain')) e.preventDefault();
    const now = new Date();
    void addFiles(files.map((f) => namePastedFile(f, now)));
  }, [addFiles]);

  const onDragEnter = useCallback((e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, []);
  const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);
  const onDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e.dataTransfer)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);
  const onDrop = useCallback((e: DragEvent<HTMLElement>) => {
    depth.current = 0;
    setDragging(false);
    const files = transferFiles(e.dataTransfer);
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }, [addFiles]);

  return { busy: pending > 0, dragging, addFiles, onPaste, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
