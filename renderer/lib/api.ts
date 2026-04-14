import type { DesktopApi } from '@bridge/ipc/contracts';

export function hasDesktopApi(): boolean {
  return typeof window !== 'undefined' && typeof window.ollamaDesktop !== 'undefined';
}

export function getDesktopApi(): DesktopApi {
  if (!hasDesktopApi()) {
    throw new Error('The preload API is unavailable in this renderer context.');
  }

  return window.ollamaDesktop;
}
