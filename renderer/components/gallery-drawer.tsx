import { useEffect, useMemo, useState } from 'react';
import type { GenerationGalleryItem } from '@bridge/ipc/contracts';
import {
  isPreviewableImagePath,
  isPreviewableVideoPath,
  loadPreviewUrl,
  openLocalPreviewPath
} from '@renderer/lib/attachments';
import { InlineVideoPlayer } from '@renderer/components/inline-video-player';
import { ThemedSelect } from '@renderer/components/themed-select';
import { formatTimestamp } from '@renderer/lib/format';
import { useEscapeClose } from '@renderer/lib/use-escape-close';
import { useFocusTrap } from '@renderer/lib/use-focus-trap';

interface GalleryDrawerProps {
  open: boolean;
  galleryItems: GenerationGalleryItem[];
  onClose?: () => void;
  onDeleteArtifact?: (itemId: string) => Promise<void> | void;
  onEditImage?: (item: GenerationGalleryItem) => void;
  onCreateVideoFromImage?: (item: GenerationGalleryItem) => void;
}

type GallerySort = 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc';
type GalleryTab = 'image' | 'video';

const SORT_OPTIONS: Array<{ value: GallerySort; label: string }> = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'name-asc', label: 'Name A-Z' },
  { value: 'name-desc', label: 'Name Z-A' }
];

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop()?.trim() || filePath;
}

function getSortTime(item: GenerationGalleryItem): number {
  return new Date(item.completedAt ?? item.createdAt).getTime();
}

function sortGalleryItems(
  items: GenerationGalleryItem[],
  sort: GallerySort
): GenerationGalleryItem[] {
  return [...items].sort((left, right) => {
    if (sort === 'date-asc') {
      return getSortTime(left) - getSortTime(right);
    }

    if (sort === 'name-asc') {
      return getFileName(left.filePath).localeCompare(getFileName(right.filePath), undefined, {
        sensitivity: 'base'
      });
    }

    if (sort === 'name-desc') {
      return getFileName(right.filePath).localeCompare(getFileName(left.filePath), undefined, {
        sensitivity: 'base'
      });
    }

    return getSortTime(right) - getSortTime(left);
  });
}

function GalleryTile(props: {
  item: GenerationGalleryItem;
  onDeleteArtifact?: (itemId: string) => Promise<void> | void;
  onEditImage?: (item: GenerationGalleryItem) => void;
  onCreateVideoFromImage?: (item: GenerationGalleryItem) => void;
  onPreviewImage?: (item: GenerationGalleryItem) => void;
}) {
  const { item } = props;
  const imagePreviewable =
    item.kind === 'image' && isPreviewableImagePath(item.filePath, item.mimeType, item.filePath);
  const videoPreviewable =
    item.kind === 'video' && isPreviewableVideoPath(item.filePath, item.mimeType, item.filePath);
  const previewSourcePath =
    imagePreviewable
      ? item.previewPath ?? item.filePath
      : videoPreviewable
        ? item.filePath
        : null;
  const [previewState, setPreviewState] = useState<{
    sourcePath: string;
    url: string | null;
  } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileName = getFileName(item.filePath);

  useEffect(() => {
    let active = true;

    if (!previewSourcePath) {
      return () => {
        active = false;
      };
    }

    void loadPreviewUrl(previewSourcePath).then((resolvedPreviewUrl) => {
      if (!active) {
        return;
      }

      setPreviewState({
        sourcePath: previewSourcePath,
        url: resolvedPreviewUrl
      });
    });

    return () => {
      active = false;
    };
  }, [previewSourcePath]);

  const previewUrl =
    previewSourcePath && previewState?.sourcePath === previewSourcePath
      ? previewState.url
      : null;
  const previewResolved =
    previewSourcePath === null || previewState?.sourcePath === previewSourcePath;
  const mediaLabel = item.kind === 'video' ? 'video' : 'image';

  async function handleOpenArtifact() {
    if (imagePreviewable) {
      props.onPreviewImage?.(item);
      return;
    }

    try {
      setOpenError(null);
      await openLocalPreviewPath(item.filePath);
    } catch (error) {
      setOpenError(
        error instanceof Error ? error.message : 'Unable to open the generated output.'
      );
    }
  }

  async function handleDeleteArtifact() {
    if (!props.onDeleteArtifact) {
      return;
    }

    const confirmed = window.confirm(
      `Delete "${fileName}" from the local gallery? This removes the generated media file from disk.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setDeleteError(null);
      setDeleting(true);
      await props.onDeleteArtifact(item.id);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : 'Unable to delete this generated media.'
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className="motion-card overflow-hidden rounded-[1.5rem] border border-white/10 bg-slate-900/70 shadow-panel">
      <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-slate-950">
        {videoPreviewable ? (
          previewUrl ? (
            <InlineVideoPlayer
              ariaLabel={item.prompt ?? fileName}
              className="h-full w-full"
              src={previewUrl}
            />
          ) : (
            <div className="motion-loader-sweep flex h-full w-full items-center justify-center px-4 text-center text-sm text-slate-500">
              {previewResolved ? 'Preview unavailable' : 'Loading video...'}
            </div>
          )
        ) : imagePreviewable ? (
          <button
            aria-label={`Open generated ${mediaLabel}`}
            className="motion-interactive flex h-full w-full items-center justify-center text-left transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-cyan-400"
            onClick={() => {
              void handleOpenArtifact();
            }}
            type="button"
          >
            {previewUrl ? (
              <img
                alt={item.prompt ?? fileName}
                className="h-full w-full object-contain"
                loading="lazy"
                src={previewUrl}
              />
            ) : (
              <div className="motion-loader-sweep flex h-full w-full items-center justify-center px-4 text-center text-sm text-slate-500">
                {previewResolved ? 'Preview unavailable' : 'Loading preview...'}
              </div>
            )}
          </button>
        ) : (
          <div className="px-4 text-center text-sm text-slate-500">
            No inline preview for this generated {mediaLabel}.
          </div>
        )}
      </div>

      <div className="space-y-3 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-200/70">
              {item.kind === 'video' ? 'Video' : 'Image'}
            </p>
            <p className="mt-2 line-clamp-2 text-sm font-medium leading-6 text-slate-100">
              {item.prompt ?? fileName}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-emerald-400/15 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-emerald-200">
            Saved
          </span>
        </div>

        <div className="flex flex-wrap gap-2 text-xs text-slate-400">
          <span>{fileName}</span>
          {item.width && item.height ? (
            <span>
              {item.width} x {item.height}
            </span>
          ) : null}
          {item.frameCount ? <span>{item.frameCount} frames</span> : null}
          {item.frameRate ? <span>{item.frameRate} fps</span> : null}
          <span>{formatTimestamp(item.completedAt ?? item.createdAt)}</span>
        </div>

        <p className="break-all text-[11px] text-slate-500">{item.filePath}</p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            className="motion-interactive rounded-xl border border-white/10 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
            onClick={() => {
              void handleOpenArtifact();
            }}
            type="button"
          >
            Open generated {mediaLabel}
          </button>
          {item.kind === 'image' && props.onEditImage ? (
            <button
              className="motion-interactive rounded-xl border border-cyan-300/20 px-3 py-2 text-xs font-medium text-cyan-100 transition hover:border-cyan-300/30 hover:bg-cyan-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              onClick={() => props.onEditImage?.(item)}
              type="button"
            >
              Edit image
            </button>
          ) : null}
          {item.kind === 'image' && props.onCreateVideoFromImage ? (
            <button
              className="motion-interactive rounded-xl border border-amber-300/20 px-3 py-2 text-xs font-medium text-amber-100 transition hover:border-amber-300/30 hover:bg-amber-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
              onClick={() => props.onCreateVideoFromImage?.(item)}
              type="button"
            >
              Make video
            </button>
          ) : null}
          {props.onDeleteArtifact ? (
            <button
              className="motion-interactive rounded-xl border border-rose-300/20 px-3 py-2 text-xs font-medium text-rose-100 transition hover:border-rose-300/30 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
              disabled={deleting}
              onClick={() => {
                void handleDeleteArtifact();
              }}
              type="button"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          ) : null}
          {openError ? <span className="text-xs text-rose-200">{openError}</span> : null}
          {deleteError ? <span className="text-xs text-rose-200">{deleteError}</span> : null}
        </div>
      </div>
    </article>
  );
}

function GalleryImagePreviewDialog(props: {
  item: GenerationGalleryItem;
  onClose: () => void;
}) {
  const { item, onClose } = props;
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewResolved, setPreviewResolved] = useState(false);
  const fileName = getFileName(item.filePath);

  useEffect(() => {
    let active = true;

    async function loadImagePreview() {
      const primaryUrl = await loadPreviewUrl(item.filePath);

      if (!active) {
        return;
      }

      if (primaryUrl) {
        setPreviewUrl(primaryUrl);
        setPreviewResolved(true);
        return;
      }

      if (item.previewPath && item.previewPath !== item.filePath) {
        const fallbackUrl = await loadPreviewUrl(item.previewPath);

        if (!active) {
          return;
        }

        setPreviewUrl(fallbackUrl);
      }

      setPreviewResolved(true);
    }

    void loadImagePreview();

    return () => {
      active = false;
    };
  }, [item.filePath, item.previewPath]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      aria-label={`Preview ${fileName}`}
      aria-modal="true"
      className="pointer-events-auto fixed inset-0 z-30 flex animate-fade-in items-center justify-center bg-slate-950/85 px-6 py-8 backdrop-blur"
      role="dialog"
    >
      <div className="flex max-h-full w-full max-w-7xl flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950 shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.24em] text-cyan-200/70">
              Image preview
            </p>
            <h3 className="mt-2 truncate text-lg font-semibold text-white">
              {item.prompt ?? fileName}
            </h3>
            <p className="mt-1 truncate text-xs text-slate-500">{item.filePath}</p>
          </div>
          <button
            aria-label="Close image preview"
            className="motion-interactive shrink-0 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-slate-950 p-4">
          {previewUrl ? (
            <img
              alt={item.prompt ?? fileName}
              className="max-h-[calc(100vh-12rem)] max-w-full object-contain"
              src={previewUrl}
            />
          ) : (
            <div className="motion-loader-sweep flex min-h-72 w-full items-center justify-center px-4 text-center text-sm text-slate-500">
              {previewResolved ? 'Preview unavailable' : 'Loading image...'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function GalleryDrawer(props: GalleryDrawerProps) {
  useEscapeClose(props.open, props.onClose);
  const focusRef = useFocusTrap(props.open);
  const [sort, setSort] = useState<GallerySort>('date-desc');
  const [activeTab, setActiveTab] = useState<GalleryTab>('image');
  const [previewImageItem, setPreviewImageItem] = useState<GenerationGalleryItem | null>(null);
  const imageItems = props.galleryItems.filter((item) => item.kind === 'image');
  const videoItems = props.galleryItems.filter((item) => item.kind === 'video');
  const visibleItems = useMemo(
    () =>
      sortGalleryItems(activeTab === 'image' ? imageItems : videoItems, sort),
    [activeTab, imageItems, sort, videoItems]
  );

  if (!props.open) {
    return null;
  }

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-16 z-20 flex animate-fade-in justify-center px-6">
        <section ref={focusRef} role="dialog" aria-modal="true" aria-label="Gallery" className="motion-drawer-up pointer-events-auto flex max-h-[calc(76vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur">
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">Gallery</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Generated media</h2>
            <p className="mt-3 text-sm leading-7 text-slate-300">
              Browse generated images and videos saved in the local generation folders.
            </p>
          </div>
          <div className="flex shrink-0 items-start gap-2">
            <ThemedSelect
              ariaLabel="Sort gallery"
              onChange={(value) => setSort(value as GallerySort)}
              options={SORT_OPTIONS}
              placement="bottom"
              size="compact"
              value={sort}
            />
            {props.onClose ? (
              <button
                aria-label="Close gallery"
                className="motion-interactive mt-1 shrink-0 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                onClick={props.onClose}
                type="button"
              >
                Close
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-5 flex shrink-0 items-center gap-2 px-6">
          {([
            ['image', `Images (${imageItems.length})`],
            ['video', `Videos (${videoItems.length})`]
          ] as const).map(([tab, label]) => (
            <button
              key={tab}
              className={`motion-interactive rounded-full border px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                activeTab === tab
                  ? 'border-cyan-300/30 bg-cyan-500/15 text-cyan-100'
                  : 'border-white/10 text-slate-300 hover:border-white/20 hover:bg-white/5'
              }`}
              onClick={() => setActiveTab(tab)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-6 pb-5">
          {visibleItems.length === 0 ? (
            <p className="motion-panel rounded-[1.5rem] border border-dashed border-white/10 px-4 py-8 text-sm text-slate-400">
              Generated {activeTab === 'image' ? 'images' : 'videos'} will appear here after jobs
              finish.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visibleItems.map((item) => (
                <GalleryTile
                  key={item.id}
                  item={item}
                  {...(props.onDeleteArtifact
                    ? { onDeleteArtifact: props.onDeleteArtifact }
                    : {})}
                  {...(props.onEditImage ? { onEditImage: props.onEditImage } : {})}
                  {...(props.onCreateVideoFromImage
                    ? { onCreateVideoFromImage: props.onCreateVideoFromImage }
                    : {})}
                  onPreviewImage={setPreviewImageItem}
                />
              ))}
            </div>
          )}
        </div>
        </section>
      </div>
      {previewImageItem ? (
        <GalleryImagePreviewDialog
          item={previewImageItem}
          onClose={() => setPreviewImageItem(null)}
        />
      ) : null}
    </>
  );
}
