# Responsive & Fluid UI with Animations — Design Spec

**Date:** 2026-04-17
**Approach:** CSS-First + Design Polish (Approach B)
**Target:** Compact desktop range (768px+)
**Animation personality:** Mixed — snappy for frequent interactions, expressive for major state changes

## 1. Responsive Layout

### Breakpoints

| Name | Min-width | Behavior |
|------|-----------|----------|
| `sm` | 768px | Compact layout: sidebar overlay, stacked header |
| `md` | 1024px | Sidebar hidden by default, toggleable overlay |
| `lg` | 1280px | Full layout: sidebar always visible |

### Sidebar Behavior

- **lg (≥1280px):** Sidebar always visible, `w-80` (320px), current behavior.
- **md (768–1279px):** Sidebar hidden by default. Hamburger toggle in header opens it as a slide-over overlay with backdrop blur. Overlay has `max-w-xs` constraint. Closes on backdrop click or Escape.
- **sm (<768px):** Same overlay behavior. Header controls stack into a compact row. Status bar pills wrap.

### Header Responsiveness (md and below)

- Add a hamburger button (☰ icon) to the left of the header title.
- Model/backend/think-mode selects wrap to a second row on md, and stack vertically with full-width labels on sm.
- "New chat" and "New workspace" buttons remain visible but may stack.
- Delete chat button hidden on sm, accessible from overflow menu or context menu.

### Status Bar Responsiveness

- On sm: `ConnectionPill` details collapse to just label + healthy/unhealthy dot. Full detail on hover/tap.
- On md: Pills show label + short detail. Full detail on hover.
- On lg: Current full detail display.

### Chat Composer Responsiveness

- Already uses `sm:grid-cols-2` for attachment grid. No change needed.
- On sm: Submit button text shortens ("Send" stays, "Generating..." → spinner only).

### Message List Responsiveness

- `max-w-[88rem]` container stays but `px-6` padding reduces to `px-4` on sm.
- Message bubbles use `ml-3` for user messages on all sizes. No change needed.

## 2. Animation System

### CSS Custom Properties (in `styles.css`)

```css
:root {
  /* Timing */
  --duration-instant: 75ms;
  --duration-fast: 150ms;
  --duration-normal: 250ms;
  --duration-slow: 400ms;
  --duration-expressive: 600ms;

  /* Easing */
  --ease-default: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-spring-gentle: cubic-bezier(0.22, 1.2, 0.36, 1);
}
```

### Animation Categories

#### Micro-interactions (Snappy: `--duration-fast`, `--ease-default`)

| Element | Property | Trigger |
|---------|----------|---------|
| All buttons | `background-color`, `border-color`, `opacity` | `:hover`, `:focus-visible` |
| Sidebar conversation items | `background-color`, `border-color` | `:hover`, active state |
| Workspace chips | `background-color`, `color` | `:hover`, active state |
| Connection pills | `background-color` | healthy/unhealthy state change |
| Dropdown menus | `opacity`, `transform: scale(0.95) → scale(1)` | open/close |

Current state: Most buttons already have `transition` class. Enhance with specific duration/easing via CSS custom properties.

#### Layout Transitions (Expressive: `--duration-slow` to `--duration-expressive`, `--ease-spring-gentle`)

| Element | Animation | Details |
|---------|-----------|---------|
| Sidebar overlay | `transform: translateX(-100%) → translateX(0)` | Slide in from left, 400ms, spring-gentle ease |
| Sidebar backdrop | `opacity: 0 → 0.5` | Fade in, 300ms, ease-out |
| Settings drawer | `transform: translateX(100%) → translateX(0)` | Slide in from right, 400ms, spring-gentle ease |
| Settings backdrop | `opacity: 0 → 0.5` | Fade in, 300ms, ease-out |
| Queue/Plan drawer | `transform: translateY(100%) → translateY(0)` | Slide up from bottom, 400ms, spring-gentle ease |
| Queue/Plan backdrop | `opacity: 0 → 1` | Fade in, 300ms |

#### Chat-Specific Animations

| Element | Animation | Details |
|---------|-----------|---------|
| Message bubbles | `opacity: 0 → 1`, `transform: translateY(8px) → translateY(0)` | Fade + slide up on mount, 250ms, ease-out |
| Pending turn indicator | Pulsing spinner (existing `animate-spin`) | Already exists, no change |
| Streaming dots | Custom keyframe `@keyframes pulse-dot` | Three dots with staggered 1.5s animation |
| Thinking block expand/collapse | `max-height` transition + `opacity` | 300ms, ease-spring-gentle |
| Generation job card | `opacity` + `transform: scale(0.98) → scale(1)` | On status change, 200ms, ease-out |
| Error state | `border-color` flash to rose then settle | 400ms total, keyframe animation |

#### Page/Section Transitions

| Element | Animation | Details |
|---------|-----------|---------|
| Empty state → messages | `opacity: 0 → 1` | Cross-fade, 300ms |
| Workspace creation form | `max-height` + `opacity` | Expand/collapse, 300ms, ease-spring-gentle |
| Settings sections | `opacity: 0 → 1`, staggered by 50ms per section | On drawer open |

### CSS Keyframes to Add (in `styles.css`)

```css
@keyframes fade-in-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slide-in-left {
  from { transform: translateX(-100%); }
  to { transform: translateX(0); }
}

@keyframes slide-in-right {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

@keyframes slide-in-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

@keyframes scale-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes pulse-dot {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}

@keyframes border-flash-rose {
  0% { border-color: rgba(244, 63, 94, 0.6); }
  100% { border-color: rgba(255, 255, 255, 0.1); }
}
```

### Tailwind Extension (in `tailwind.config.ts`)

```ts
theme: {
  extend: {
    transitionDuration: {
      'instant': '75ms',
      'expressive': '600ms',
    },
    transitionTimingFunction: {
      'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      'spring-gentle': 'cubic-bezier(0.22, 1.2, 0.36, 1)',
    },
    animation: {
      'fade-in-up': 'fade-in-up 250ms var(--ease-out, cubic-bezier(0, 0, 0.2, 1))',
      'fade-in': 'fade-in 300ms var(--ease-out, cubic-bezier(0, 0, 0.2, 1))',
      'slide-in-left': 'slide-in-left 400ms var(--ease-spring-gentle, cubic-bezier(0.22, 1.2, 0.36, 1))',
      'slide-in-right': 'slide-in-right 400ms var(--ease-spring-gentle, cubic-bezier(0.22, 1.2, 0.36, 1))',
      'slide-in-up': 'slide-in-up 400ms var(--ease-spring-gentle, cubic-bezier(0.22, 1.2, 0.36, 1))',
      'scale-in': 'scale-in 200ms var(--ease-out, cubic-bezier(0, 0, 0.2, 1))',
      'pulse-dot': 'pulse-dot 1.5s ease-in-out infinite',
      'border-flash-rose': 'border-flash-rose 400ms ease-out',
    },
    screens: {
      'sm': '768px',
      'md': '1024px',
    },
  },
},
```

**Note:** Tailwind default `sm` is 640px. We override to 768px since this is a desktop Electron app and don't need mobile breakpoints. The `md` override from 768→1024px gives us the sidebar toggle breakpoint.

## 3. Component Changes

### New Component: `SidebarToggle`

A hamburger button rendered in the header area on md and below. Calls `toggleSidebar()` from store.

```tsx
// Only visible below lg breakpoint
<button className="lg:hidden ..." onClick={toggleSidebar}>
  {/* Hamburger icon SVG */}
</button>
```

### Store Changes (`app-store.ts`)

Add:
- `sidebarOpen: boolean` (default: based on screen width — `true` at ≥1280px, `false` otherwise)
- `toggleSidebar(): void` — toggles sidebar overlay on md and below
- Listen to `window.matchMedia('(min-width: 1280px)')` to auto-open/close sidebar on resize

### `Sidebar` Component

- At `lg+`: rendered inline with `flex` layout (current behavior, always visible)
- Below `lg`: rendered as a fixed overlay with backdrop, animated slide-in from left
- Accept `overlayMode?: boolean` prop from `ChatPage` based on screen width
- In overlay mode: `fixed inset-y-0 left-0 z-30` with backdrop overlay behind it

### `ChatPage` Layout Changes

Current:
```tsx
<div className="flex min-h-0 flex-1">
  <Sidebar ... />
  <div className="flex min-w-0 flex-1 flex-col">
```

Proposed:
```tsx
<div className="flex min-h-0 flex-1">
  {/* Inline sidebar at lg+, hidden below */}
  <div className="hidden lg:block">
    <Sidebar ... />
  </div>
  {/* Overlay sidebar at md and below */}
  {sidebarOpen && (
    <>
      <div className="fixed inset-0 z-20 bg-slate-950/50 backdrop-blur-sm animate-fade-in lg:hidden"
           onClick={() => toggleSidebar(false)} />
      <aside className="fixed inset-y-0 left-0 z-30 w-80 animate-slide-in-left lg:hidden">
        <Sidebar ... overlayMode />
      </aside>
    </>
  )}
  <div className="flex min-w-0 flex-1 flex-col">
```

### Header Responsiveness

- Add `SidebarToggle` button before the title on `md` and below
- Wrap model/backend selects in a collapsible row:
  - `lg+`: all selects inline (current)
  - `md`: selects wrap to second line
  - `sm`: backend, model, and think-mode selects move to a secondary row below the title, full width, stacked vertically with smaller labels

### `SettingsDrawer` Animation

Current: conditional render (`if (!props.open) return null`)
Proposed: Always render when open, add enter/exit animations:
- Backdrop: `animate-fade-in`
- Panel: `animate-slide-in-right`
- Sections: staggered fade-in with `animation-delay` inline styles

### `QueueDrawer` / `PlanDrawer` Animation

Current: conditional render
Proposed: Same pattern — `animate-slide-in-up` for the panel, `animate-fade-in` for backdrop area

### `MessageBubble` Animation

Add `animate-fade-in-up` class to the `<article>` wrapper. Since React re-renders on new messages, the animation plays on mount.

### `StatusBar` Animation

`ConnectionPill` health state changes: transition `background-color` and `border-color` with `duration-fast`.

## 4. Accessibility

- All animations respect `prefers-reduced-motion: reduce` (already handled globally in `styles.css`)
- The sidebar overlay is trapped-focus when open (arrow keys cycle within)
- Escape key closes sidebar overlay and all drawers
- Hamburger button has `aria-expanded` reflecting sidebar state
- All animated elements have appropriate `role` and `aria` attributes

## 5. Files to Modify

| File | Change |
|------|--------|
| `renderer/styles.css` | Add CSS custom properties, keyframes |
| `tailwind.config.ts` | Add `screens`, `transitionDuration`, `transitionTimingFunction`, `animation` extensions |
| `renderer/pages/chat-page.tsx` | Responsive sidebar (overlay/inline), hamburger toggle, responsive header |
| `renderer/components/sidebar.tsx` | Accept `overlayMode` prop, add close button in overlay mode |
| `renderer/components/title-bar.tsx` | No change (custom title bar handles its own sizing) |
| `renderer/components/status-bar.tsx` | Responsive pill detail collapsing on sm |
| `renderer/components/settings-drawer.tsx` | Add slide-in animation, section stagger |
| `renderer/components/queue-drawer.tsx` | Add slide-up animation |
| `renderer/components/plan-drawer.tsx` | Add slide-up animation |
| `renderer/components/message-bubble.tsx` | Add `animate-fade-in-up` on mount |
| `renderer/components/message-list.tsx` | Responsive padding (`px-4 sm:px-6`) |
| `renderer/components/chat-composer.tsx` | Responsive padding, button text shortening on sm |
| `renderer/store/app-store.ts` | Add `sidebarOpen`, `toggleSidebar`, matchMedia listener |

## 6. Out of Scope

- Mobile breakpoints (<768px) — not a mobile app
- Touch gesture support (swipe to close sidebar, pull-to-refresh)
- Route transitions (only one route exists)
- Skeleton loading states (no data loading UI patterns yet)
- Light theme animations (currently dark-only)
- Animation performance optimization (will use `will-change` and `transform` only where needed)
- framer-motion or any animation library