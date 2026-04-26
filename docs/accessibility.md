# Accessibility

Helix follows WAI-ARIA patterns for its drawer-based UI and interactive components.

## Drawer Components

All drawer-like overlays (settings, queue, gallery, skills, agents, plan) use:

- `useEscapeClose(open, onClose)` — global keydown listener that calls `onClose` on Escape.
- `useFocusTrap(open)` — manages focus within the drawer container; Tab/Shift+Tab cycle through focusable elements; restores focus to the previously active element on close.
- `role="dialog"` and `aria-modal="true"` — marks the drawer as a modal dialog for screen readers.
- `aria-label` — provides an accessible name (e.g., "Settings", "Gallery").

## Context Menu

- `role="menu"` on the container, `role="menuitem"` on items.
- Arrow key navigation: ArrowDown/ArrowUp cycle through enabled items, Home/End jump to first/last.
- Escape closes the menu.
- `tabIndex={0}` on enabled items for keyboard focusability.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Escape | Close active drawer or context menu |
| Tab / Shift+Tab | Cycle through focusable elements (trapped in open drawer) |
| ArrowDown / ArrowUp | Navigate context menu items |
| Home / End | Jump to first/last context menu item |

## Known Gaps

- **Sidebar conversation list**: No arrow-key navigation for list items.
- **Settings drawer tabs**: No arrow-key navigation between tab buttons.
- **Screen reader announcements**: Limited `aria-live` regions — only chat page status, composer status, and message list use `aria-live="polite"`. Error states in settings and generation drawers are not announced.
- **Color contrast**: Text uses Tailwind slate scale on dark backgrounds. Small text (11px) uses `text-slate-400` minimum (4.5:1+ contrast on slate-950).
- **`sandbox: true`**: Preload currently uses Node.js APIs directly. Enabling sandbox mode requires bundling the preload script with only browser-compatible APIs.

## Files

- `renderer/lib/use-escape-close.ts` — Escape key hook
- `renderer/lib/use-focus-trap.ts` — Focus trap hook
- `renderer/components/context-menu.tsx` — Keyboard-navigable context menu
- `renderer/components/settings-drawer.tsx` — A11y drawer reference implementation