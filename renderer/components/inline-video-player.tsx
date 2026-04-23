import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ChangeEvent
} from 'react';

interface InlineVideoPlayerProps {
  src: string;
  poster?: string;
  className?: string;
  ariaLabel?: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function InlineVideoPlayer(props: InlineVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [buffered, setBuffered] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onLoaded = () => setDuration(video.duration || 0);
    const onVolumeChange = () => setIsMuted(video.muted);
    const onProgress = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1));
      }
    };
    const onEnded = () => {
      if (!video.loop) {
        setIsPlaying(false);
      }
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('durationchange', onLoaded);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('progress', onProgress);
    video.addEventListener('ended', onEnded);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('durationchange', onLoaded);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('ended', onEnded);
    };
  }, []);

  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement === container) {
      void document.exitFullscreen();
    } else {
      void container.requestFullscreen();
    }
  }, []);

  const toggleLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.loop = !video.loop;
    setIsLooping(video.loop);
  }, []);

  const handleSeek = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Number(event.target.value);
    video.currentTime = next;
    setCurrentTime(next);
  }, []);

  const handleVideoClick = useCallback((event: ReactMouseEvent<HTMLVideoElement>) => {
    event.preventDefault();
    togglePlay();
  }, [togglePlay]);

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className={`group/video relative h-full w-full overflow-hidden bg-slate-950 ${props.className ?? ''}`}
    >
      <video
        ref={videoRef}
        className="h-full w-full object-contain"
        preload="metadata"
        playsInline
        poster={props.poster}
        src={props.src}
        aria-label={props.ariaLabel}
        onClick={handleVideoClick}
      />

      {!isPlaying ? (
        <button
          type="button"
          aria-label="Play video"
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center bg-slate-950/40 transition hover:bg-slate-950/55 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full border border-cyan-300/40 bg-slate-900/70 text-cyan-200 shadow-[0_0_24px_rgba(34,211,238,0.25)] backdrop-blur-sm transition group-hover/video:border-cyan-200/70 group-hover/video:text-cyan-100">
            <svg viewBox="0 0 24 24" className="ml-0.5 h-6 w-6" fill="currentColor" aria-hidden>
              <path d="M8 5.5v13l11-6.5-11-6.5z" />
            </svg>
          </span>
        </button>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-slate-950/90 via-slate-950/55 to-transparent px-3 pb-2.5 pt-6 opacity-0 transition-opacity duration-200 group-hover/video:opacity-100 group-focus-within/video:opacity-100 [&:has(input:focus)]:opacity-100">
        <div className="pointer-events-auto relative h-1.5 w-full">
          <div className="absolute inset-0 rounded-full bg-white/10" />
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white/20"
            style={{ width: `${bufferedPct}%` }}
          />
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.55)]"
            style={{ width: `${progressPct}%` }}
          />
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.05}
            value={currentTime}
            onChange={handleSeek}
            aria-label="Seek"
            className="video-scrubber absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent"
          />
        </div>

        <div className="pointer-events-auto flex items-center gap-2 text-xs text-slate-200">
          <button
            type="button"
            aria-label={isPlaying ? 'Pause' : 'Play'}
            onClick={togglePlay}
            className="flex h-7 w-7 items-center justify-center rounded-full text-slate-100 transition hover:bg-white/10 hover:text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="ml-0.5 h-4 w-4" fill="currentColor" aria-hidden>
                <path d="M8 5.5v13l11-6.5-11-6.5z" />
              </svg>
            )}
          </button>

          <span className="font-mono text-[11px] tabular-nums text-slate-300">
            {formatTime(currentTime)} <span className="text-slate-500">/</span> {formatTime(duration)}
          </span>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              aria-label={isMuted ? 'Unmute' : 'Mute'}
              onClick={toggleMute}
              className="flex h-7 w-7 items-center justify-center rounded-full text-slate-100 transition hover:bg-white/10 hover:text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
            >
              {isMuted ? (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 00-1.32-3.18l-1.06 1.06a3 3 0 010 4.24l1.06 1.06A4.5 4.5 0 0016.5 12zm-2.46-5.54L20 12l-2 2 2 2-1.06 1.06-2-2-2 2L13.88 16l2-2-2-2 1.16-1.54z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <path d="M3 10v4h4l5 4V6L7 10H3zm11.5 2a4.5 4.5 0 00-2.5-4.03v8.06A4.5 4.5 0 0014.5 12zm-2.5-7v2.06a7 7 0 010 9.88V19a9 9 0 000-14z" />
                </svg>
              )}
            </button>

            <button
              type="button"
              aria-label={isLooping ? 'Disable repeat' : 'Enable repeat'}
              onClick={toggleLoop}
              className={`flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 ${isLooping ? 'text-cyan-300' : 'text-slate-100 hover:text-cyan-100'}`}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
              </svg>
            </button>

            <button
              type="button"
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              onClick={toggleFullscreen}
              className="flex h-7 w-7 items-center justify-center rounded-full text-slate-100 transition hover:bg-white/10 hover:text-cyan-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
            >
              {isFullscreen ? (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <path d="M9 9H5v2h6V5H9v4zm6 0V5h-2v6h6V9h-4zM9 19v-4H3v2h4v2h2zm6-4v4h2v-2h4v-2h-6z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
