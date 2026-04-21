import { useEffect, useState } from 'react';
import type { MessageAttachment } from '@bridge/ipc/contracts';
import { formatBytes } from '@renderer/lib/format';
import {
  isPreviewableImageAttachment,
  loadAttachmentPreviewUrl,
  openLocalPreviewPath
} from '@renderer/lib/attachments';

interface AttachmentCardProps {
  attachment: MessageAttachment;
  onRemove?: (attachmentId: string) => void;
}

export function AttachmentCard(props: AttachmentCardProps) {
  const { attachment } = props;
  const previewableImage = isPreviewableImageAttachment(attachment);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewResolved, setPreviewResolved] = useState(!previewableImage);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    if (!previewableImage) {
      return () => {
        active = false;
      };
    }

    void loadAttachmentPreviewUrl(attachment).then((resolvedPreviewUrl) => {
      if (!active) {
        return;
      }

      setPreviewUrl(resolvedPreviewUrl);
      setPreviewResolved(true);
    });

    return () => {
      active = false;
    };
  }, [attachment, previewableImage]);

  const detailLabel = previewUrl
    ? 'Preview available'
    : attachment.extractedText
      ? 'Text included in context'
      : previewableImage && !previewResolved
        ? 'Loading preview'
        : 'Metadata only';

  async function handleOpenPreview() {
    if (!attachment.filePath) {
      return;
    }

    try {
      setOpenError(null);
      await openLocalPreviewPath(attachment.filePath);
    } catch (error) {
      setOpenError(
        error instanceof Error ? error.message : 'Unable to open the selected file.'
      );
    }
  }

  return (
    <div className="motion-card motion-panel overflow-hidden rounded-2xl border border-white/10 bg-slate-950/80">
      {previewableImage ? (
        <button
          aria-label={`Open ${attachment.fileName}`}
          className="motion-interactive block w-full overflow-hidden bg-slate-950 text-left transition hover:bg-slate-900/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
          onClick={() => {
            void handleOpenPreview();
          }}
          type="button"
        >
          <div className="flex max-h-72 min-h-36 items-center justify-center overflow-hidden bg-slate-950">
            {previewUrl ? (
              <img
                alt={attachment.fileName}
                className="max-h-72 w-full object-contain"
                loading="lazy"
                src={previewUrl}
              />
            ) : (
              <div className="motion-loader-sweep flex h-full w-full items-center justify-center px-4 text-center text-sm text-slate-500">
                {previewResolved ? 'Preview unavailable' : 'Loading preview...'}
              </div>
            )}
          </div>
        </button>
      ) : null}

      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-100">{attachment.fileName}</p>
          <p className="mt-1 text-xs text-slate-400">
            {[attachment.mimeType ?? 'File', formatBytes(attachment.sizeBytes)].join(' | ')}
          </p>
          <p className="mt-1 text-xs text-cyan-200/80">{detailLabel}</p>
          {previewableImage && attachment.filePath ? (
            <p className="mt-1 text-[11px] text-slate-500">Click preview to open</p>
          ) : null}
          {openError ? (
            <p className="mt-2 text-xs text-rose-200">{openError}</p>
          ) : null}
        </div>

        {props.onRemove ? (
          <button
            aria-label={`Remove ${attachment.fileName}`}
            className="motion-interactive rounded-full border border-white/10 px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
            onClick={() => props.onRemove?.(attachment.id)}
            type="button"
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}
