import path from 'node:path';
import type { MessageAttachment } from '@bridge/ipc/contracts';

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.c',
  '.cpp',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
]);

const IMAGE_ATTACHMENT_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp'
]);

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.png': 'image/png',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.sql': 'application/sql',
  '.svg': 'image/svg+xml',
  '.toml': 'application/toml',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml'
};

function getAttachmentExtension(value: string): string {
  return path.extname(value).toLowerCase();
}

export function isImageFilePath(filePath: string): boolean {
  return IMAGE_ATTACHMENT_EXTENSIONS.has(getAttachmentExtension(filePath));
}

export function inferMimeType(filePath: string): string | null {
  const extension = getAttachmentExtension(filePath);
  return MIME_TYPE_BY_EXTENSION[extension] ?? null;
}

export function canInlineAttachmentText(filePath: string, sizeBytes: number): boolean {
  return (
    TEXT_ATTACHMENT_EXTENSIONS.has(getAttachmentExtension(filePath)) &&
    sizeBytes <= 256_000
  );
}

export function isImageAttachment(attachment: MessageAttachment): boolean {
  return (
    attachment.mimeType?.startsWith('image/') === true ||
    isImageFilePath(attachment.filePath ?? attachment.fileName)
  );
}
