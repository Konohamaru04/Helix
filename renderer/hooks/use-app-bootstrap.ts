import { useEffect } from 'react';
import { getDesktopApi, hasDesktopApi } from '@renderer/lib/api';
import { useAppStore } from '@renderer/store/app-store';

const SYSTEM_STATUS_POLL_INTERVAL_MS = 3_000;

export function useAppBootstrap() {
  const loadInitialData = useAppStore((state) => state.loadInitialData);
  const applyStreamEvent = useAppStore((state) => state.applyStreamEvent);
  const applyGenerationEvent = useAppStore((state) => state.applyGenerationEvent);
  const refreshSystemStatus = useAppStore((state) => state.refreshSystemStatus);

  useEffect(() => {
    if (!hasDesktopApi()) {
      return;
    }

    void loadInitialData();
    const refreshStatus = () => {
      void refreshSystemStatus().catch(() => undefined);
    };
    const unsubscribeChat = getDesktopApi().chat.onStreamEvent((event) => {
      applyStreamEvent(event);
    });
    const unsubscribeGeneration = getDesktopApi().generation.onJobEvent((event) => {
      applyGenerationEvent(event);
    });
    const pollHandle = window.setInterval(refreshStatus, SYSTEM_STATUS_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(pollHandle);
      unsubscribeChat();
      unsubscribeGeneration();
    };
  }, [applyGenerationEvent, applyStreamEvent, loadInitialData, refreshSystemStatus]);
}
