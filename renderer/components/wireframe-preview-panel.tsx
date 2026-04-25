import {
  type PointerEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  buildWireframePreviewDocument,
  type WireframeDesignIteration
} from '@renderer/lib/wireframe';

interface WireframePreviewPanelProps {
  iterations: WireframeDesignIteration[];
  onSelectIteration?: (iterationId: string) => void;
  selectedIterationId?: string | null;
}

type PreviewTool = 'pointer' | 'drag';

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.4;
const ZOOM_STEP = 0.12;
const CANVAS_WIDTH = 1366;
const CANVAS_HEIGHT = 1100;
const CANVAS_PADDING = 96;
const SCROLL_LOCK_MS = 180;

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function collectScrollableAncestors(element: HTMLElement | null) {
  const ancestors: HTMLElement[] = [];
  let currentElement = element?.parentElement ?? null;

  while (currentElement) {
    const style = window.getComputedStyle(currentElement);
    const scrollableY =
      /(auto|scroll|overlay)/.test(style.overflowY) &&
      currentElement.scrollHeight > currentElement.clientHeight;
    const scrollableX =
      /(auto|scroll|overlay)/.test(style.overflowX) &&
      currentElement.scrollWidth > currentElement.clientWidth;

    if (scrollableY || scrollableX) {
      ancestors.push(currentElement);
    }

    currentElement = currentElement.parentElement;
  }

  return ancestors;
}

export function WireframePreviewPanel(props: WireframePreviewPanelProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const scrollLockFrameRef = useRef<number | null>(null);
  const onSelectIterationRef = useRef(props.onSelectIteration);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const didFitContentRef = useRef(false);
  const [tool, setTool] = useState<PreviewTool>('pointer');
  const [zoom, setZoom] = useState(0.74);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [contentSize, setContentSize] = useState({
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT
  });
  const [localSelectedIterationId, setLocalSelectedIterationId] = useState(
    () => props.selectedIterationId ?? props.iterations.at(-1)?.id ?? ''
  );
  const selectedIterationId = props.selectedIterationId ?? localSelectedIterationId;
  const selectedIteration =
    props.iterations.find((iteration) => iteration.id === selectedIterationId) ??
    props.iterations.at(-1);
  const selectedDesign = selectedIteration?.design ?? props.iterations[0]?.design;
  const previewDocument = useMemo(
    () => (selectedDesign ? buildWireframePreviewDocument(selectedDesign) : ''),
    [selectedDesign]
  );
  const downloadUrl = useMemo(
    () =>
      URL.createObjectURL(
        new Blob([previewDocument], {
          type: 'text/html;charset=utf-8'
        })
      ),
    [previewDocument]
  );

  useEffect(
    () => () => {
      URL.revokeObjectURL(downloadUrl);
    },
    [downloadUrl]
  );

  useEffect(
    () => () => {
      if (scrollLockFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollLockFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    onSelectIterationRef.current = props.onSelectIteration;
  }, [props.onSelectIteration]);
  const safeTitle = (selectedDesign?.title ?? 'wireframe')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'wireframe';

  useEffect(() => {
    const latestIterationId = props.iterations.at(-1)?.id ?? '';
    setLocalSelectedIterationId(latestIterationId);
    onSelectIterationRef.current?.(latestIterationId);
  }, [props.iterations]);

  useEffect(() => {
    setZoom(0.74);
    setPan({ x: 0, y: 0 });
    setTool('pointer');
    setContentSize({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
    didFitContentRef.current = false;
  }, [selectedIteration?.id]);

  useEffect(() => {
    if (tool !== 'drag') {
      return;
    }

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    return () => {
      document.body.style.userSelect = previousUserSelect;
    };
  }, [tool]);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    function handleNativeWheel(event: globalThis.WheelEvent) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const direction = event.deltaY > 0 ? -1 : 1;
      updateZoom(zoom + direction * ZOOM_STEP, {
        x: event.clientX,
        y: event.clientY
      });
    }

    viewport.addEventListener('wheel', handleNativeWheel, {
      capture: true,
      passive: false
    });

    return () => {
      viewport.removeEventListener('wheel', handleNativeWheel, {
        capture: true
      });
    };
  }, [zoom]);

  useEffect(() => {
    function handlePreviewMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }

      const data = event.data as
        | {
            source?: string;
            type?: string;
            deltaY?: number;
            clientX?: number;
            clientY?: number;
            width?: number;
            height?: number;
          }
        | undefined;

      if (data?.source !== 'helix-wireframe-preview') {
        return;
      }

      if (
        data.type === 'resize' &&
        typeof data.width === 'number' &&
        typeof data.height === 'number'
      ) {
        const nextWidth = Math.max(CANVAS_WIDTH, Math.ceil(data.width));
        const nextHeight = Math.max(CANVAS_HEIGHT, Math.ceil(data.height));
        let didChange = false;
        setContentSize((current) => {
          if (current.width === nextWidth && current.height === nextHeight) {
            return current;
          }
          didChange = true;
          return { width: nextWidth, height: nextHeight };
        });
        if (didChange && !didFitContentRef.current) {
          didFitContentRef.current = true;
          window.requestAnimationFrame(() => {
            const viewport = viewportRef.current;
            if (!viewport) {
              return;
            }
            const fitZoom = clampZoom(
              Math.min(
                (viewport.clientWidth - CANVAS_PADDING) / nextWidth,
                (viewport.clientHeight - CANVAS_PADDING) / nextHeight
              )
            );
            setZoom(fitZoom);
            setPan({
              x: Math.max(24, (viewport.clientWidth - nextWidth * fitZoom) / 2),
              y: Math.max(24, (viewport.clientHeight - nextHeight * fitZoom) / 2)
            });
          });
        }
        return;
      }

      if (data.type !== 'wheel' || typeof data.deltaY !== 'number') {
        return;
      }

      const iframeBounds = iframeRef.current?.getBoundingClientRect();
      const direction = data.deltaY > 0 ? -1 : 1;
      const anchor =
        iframeBounds &&
        typeof data.clientX === 'number' &&
        typeof data.clientY === 'number'
          ? {
              x: iframeBounds.left + data.clientX * zoom,
              y: iframeBounds.top + data.clientY * zoom
            }
          : undefined;

      lockAncestorScroll();
      updateZoom(zoom + direction * ZOOM_STEP, anchor);
    }

    window.addEventListener('message', handlePreviewMessage);

    return () => {
      window.removeEventListener('message', handlePreviewMessage);
    };
  }, [zoom]);

  function lockAncestorScroll() {
    const lockedAncestors = collectScrollableAncestors(viewportRef.current).map(
      (element) => ({
        element,
        left: element.scrollLeft,
        top: element.scrollTop
      })
    );

    if (lockedAncestors.length === 0) {
      return;
    }

    const lockUntil = performance.now() + SCROLL_LOCK_MS;

    if (scrollLockFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollLockFrameRef.current);
    }

    function restoreScroll() {
      for (const lock of lockedAncestors) {
        lock.element.scrollTop = lock.top;
        lock.element.scrollLeft = lock.left;
      }

      if (performance.now() < lockUntil) {
        scrollLockFrameRef.current = window.requestAnimationFrame(restoreScroll);
        return;
      }

      scrollLockFrameRef.current = null;
    }

    restoreScroll();
  }

  function updateZoom(nextZoom: number, anchor?: { x: number; y: number }) {
    setZoom((currentZoom) => {
      const clampedZoom = clampZoom(nextZoom);

      if (!anchor || !viewportRef.current || clampedZoom === currentZoom) {
        return clampedZoom;
      }

      const bounds = viewportRef.current.getBoundingClientRect();
      const localAnchor = {
        x: anchor.x - bounds.left,
        y: anchor.y - bounds.top
      };
      const scaleRatio = clampedZoom / currentZoom;

      setPan((currentPan) => ({
        x: localAnchor.x - (localAnchor.x - currentPan.x) * scaleRatio,
        y: localAnchor.y - (localAnchor.y - currentPan.y) * scaleRatio
      }));

      return clampedZoom;
    });
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const direction = event.deltaY > 0 ? -1 : 1;
    updateZoom(zoom + direction * ZOOM_STEP, {
      x: event.clientX,
      y: event.clientY
    });
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (tool !== 'drag') {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    setPan({
      x: dragState.originX + event.clientX - dragState.startX,
      y: dragState.originY + event.clientY - dragState.startY
    });
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
    }
  }

  function fitCanvas() {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const nextZoom = clampZoom(
      Math.min(
        (viewport.clientWidth - CANVAS_PADDING) / contentSize.width,
        (viewport.clientHeight - CANVAS_PADDING) / contentSize.height
      )
    );

    setZoom(nextZoom);
    setPan({
      x: Math.max(24, (viewport.clientWidth - contentSize.width * nextZoom) / 2),
      y: Math.max(24, (viewport.clientHeight - contentSize.height * nextZoom) / 2)
    });
  }

  return (
    <section
      aria-label="Wireframe preview"
      className="motion-panel mx-auto flex w-full max-w-[88rem] flex-col overflow-hidden rounded-[1.25rem] border border-cyan-300/20 bg-slate-900/70 shadow-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.22em] text-cyan-200/80">
            Wireframe Canvas
          </p>
          <h2 className="mt-1 truncate text-base font-semibold text-slate-100">
            {selectedDesign?.title ?? 'Wireframe'}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            aria-label="Preview interaction mode"
            className="inline-flex rounded-2xl border border-white/10 bg-slate-950/60 p-1"
            role="group"
          >
            {(['pointer', 'drag'] as const).map((mode) => (
              <button
                aria-pressed={tool === mode}
                className={`motion-interactive rounded-xl px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] ${
                  tool === mode
                    ? 'bg-cyan-400 text-slate-950'
                    : 'text-slate-300 hover:bg-white/5'
                }`}
                key={mode}
                onClick={() => setTool(mode)}
                type="button"
              >
                {mode}
              </button>
            ))}
          </div>

          <div
            aria-label="Preview zoom controls"
            className="inline-flex items-center rounded-2xl border border-white/10 bg-slate-950/60 p-1"
            role="group"
          >
            <button
              aria-label="Zoom out"
              className="motion-interactive h-8 w-8 rounded-xl text-sm font-semibold text-slate-200 hover:bg-white/5"
              onClick={() => updateZoom(zoom - ZOOM_STEP)}
              type="button"
            >
              -
            </button>
            <button
              className="motion-interactive min-w-14 rounded-xl px-2 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/5"
              onClick={fitCanvas}
              type="button"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              aria-label="Zoom in"
              className="motion-interactive h-8 w-8 rounded-xl text-sm font-semibold text-slate-200 hover:bg-white/5"
              onClick={() => updateZoom(zoom + ZOOM_STEP)}
              type="button"
            >
              +
            </button>
          </div>

          <a
            className="motion-interactive rounded-2xl border border-cyan-300/30 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-50 transition hover:bg-cyan-400/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
            download={`${safeTitle}.html`}
            href={downloadUrl}
          >
            Export HTML
          </a>
        </div>
      </div>

      <div className="grid min-h-[34rem] grid-rows-[1fr_auto] bg-slate-950/70 lg:grid-cols-[1fr_20rem] lg:grid-rows-1">
        <div
          aria-label="Pan and zoom wireframe canvas"
          className={`relative h-[34rem] touch-none overflow-hidden bg-white ${
            tool === 'drag' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
          }`}
          onDragStart={(event) => event.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onSelect={(event) => {
            if (tool === 'drag') {
              event.preventDefault();
            }
          }}
          onWheel={handleWheel}
          ref={viewportRef}
          style={{
            overscrollBehavior: 'none',
            touchAction: 'none',
            userSelect: tool === 'drag' ? 'none' : 'auto'
          }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left select-none"
            style={{
              height: contentSize.height,
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              width: contentSize.width
            }}
          >
            <iframe
              className={`h-full w-full border-0 bg-transparent ${
                tool === 'drag' ? 'pointer-events-none' : ''
              }`}
              draggable={false}
              ref={iframeRef}
              sandbox="allow-scripts"
              scrolling="no"
              srcDoc={previewDocument}
              title={`${selectedDesign?.title ?? 'Wireframe'} preview`}
            />
          </div>

          {tool === 'drag' ? (
            <div
              aria-hidden="true"
              className="absolute inset-0 cursor-grab select-none active:cursor-grabbing"
              onDragStart={(event) => event.preventDefault()}
            />
          ) : null}

          {tool === 'drag' ? (
            <div className="pointer-events-none absolute bottom-4 left-4 rounded-2xl border border-white/10 bg-slate-950/85 px-3 py-2 text-xs text-slate-200 shadow-panel">
              Drag to pan. Use wheel or controls to zoom.
            </div>
          ) : (
            <div className="pointer-events-none absolute bottom-4 left-4 rounded-2xl border border-white/10 bg-slate-950/85 px-3 py-2 text-xs text-slate-200 shadow-panel">
              Pointer mode: interact with the design.
            </div>
          )}
        </div>
        <aside className="border-t border-white/10 bg-slate-950/80 p-4 lg:border-l lg:border-t-0">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
            Iterations
          </p>
          <div className="mt-3 space-y-2">
            {props.iterations.map((iteration, index) => {
              const selected = iteration.id === selectedIteration?.id;

              return (
                <button
                  aria-pressed={selected}
                  className={`motion-interactive w-full rounded-2xl border px-3 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 ${
                    selected
                      ? 'border-cyan-300/40 bg-cyan-400/10 text-cyan-50'
                      : 'border-white/10 bg-slate-900/45 text-slate-300 hover:border-white/20 hover:bg-white/5'
                  }`}
                  key={iteration.id}
                  onClick={() => {
                    setLocalSelectedIterationId(iteration.id);
                    props.onSelectIteration?.(iteration.id);
                  }}
                  type="button"
                >
                  <span className="block text-xs font-semibold uppercase tracking-[0.18em]">
                    Version {index + 1}
                  </span>
                  <span className="mt-1 block truncate text-sm font-medium">
                    {iteration.design.title}
                  </span>
                  <span className="mt-1 block text-xs text-slate-500">
                    {new Date(iteration.createdAt).toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-4 rounded-2xl border border-white/10 bg-slate-900/45 px-3 py-3">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
              Export
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              Export downloads the selected version as one self-contained HTML file.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
