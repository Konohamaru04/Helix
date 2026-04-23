import type { MessageAttachment } from '@bridge/ipc/contracts';
import { getDesktopApi, hasDesktopApi } from '@renderer/lib/api';

const IMAGE_EXTENSION_PATTERN = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const VIDEO_EXTENSION_PATTERN = /\.mp4$/i;
const previewUrlCache = new Map<string, string>();
const previewPromiseCache = new Map<string, Promise<string | null>>();

export function isPreviewableImageAttachment(attachment: MessageAttachment): boolean {
  return (
    attachment.filePath !== null &&
    isPreviewableImagePath(attachment.filePath, attachment.mimeType, attachment.fileName)
  );
}

export function isPreviewableImagePath(
  filePath: string | null,
  mimeType?: string | null,
  label?: string | null
): boolean {
  if (!filePath) {
    return false;
  }

  return (
    mimeType?.startsWith('image/') === true ||
    IMAGE_EXTENSION_PATTERN.test(label ?? filePath)
  );
}

export function isPreviewableVideoPath(
  filePath: string | null,
  mimeType?: string | null,
  label?: string | null
): boolean {
  if (!filePath) {
    return false;
  }

  return (
    mimeType?.startsWith('video/') === true ||
    VIDEO_EXTENSION_PATTERN.test(label ?? filePath)
  );
}

export async function loadPreviewUrl(filePath: string | null): Promise<string | null> {
  if (!filePath || !hasDesktopApi()) {
    return null;
  }

  const cacheKey = filePath;

  if (previewUrlCache.has(cacheKey)) {
    return previewUrlCache.get(cacheKey) ?? null;
  }

  const existingPromise = previewPromiseCache.get(cacheKey);

  if (existingPromise) {
    return existingPromise;
  }

  const previewPromise = getDesktopApi()
    .chat.getAttachmentPreview({ filePath })
    .then((result) => {
      previewUrlCache.set(cacheKey, result.dataUrl);
      previewPromiseCache.delete(cacheKey);
      return result.dataUrl;
    })
    .catch(() => {
      previewPromiseCache.delete(cacheKey);
      return null;
    });

  previewPromiseCache.set(cacheKey, previewPromise);
  return previewPromise;
}

export async function loadAttachmentPreviewUrl(
  attachment: MessageAttachment
): Promise<string | null> {
  return loadPreviewUrl(attachment.filePath);
}

export async function openLocalPreviewPath(filePath: string | null): Promise<void> {
  if (!filePath || !hasDesktopApi()) {
    throw new Error('The local file is unavailable in this renderer context.');
  }

  await getDesktopApi().chat.openLocalPath({ filePath });
}
