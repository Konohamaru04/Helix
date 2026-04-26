import { useEffect } from 'react';

export function useEscapeClose(open: boolean, onClose?: () => void): void {
  useEffect(() => {
    if (!open || !onClose) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [open, onClose]);
}
