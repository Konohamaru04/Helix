# Responsive & Fluid UI with Animations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Helix desktop UI responsive from 768px+ with fluid CSS animations — sidebar overlay on narrow windows, animated drawers, message entrance animations, and micro-interactions.

**Architecture:** CSS-first approach using Tailwind config extensions + CSS custom properties + keyframes. No new JS dependencies. Responsive breakpoints override Tailwind defaults (sm=768, md=1024). Zustand store gains `sidebarOpen` state for overlay toggle.

**Tech Stack:** React, Tailwind CSS, Zustand, CSS custom properties, CSS keyframes

---

### Task 1: Tailwind Config — Breakpoints & Animation Tokens

**Files:**
- Modify: `tailwind.config.ts`
- Modify: `renderer/styles.css`

- [ ] **Step 1: Add CSS custom properties to `styles.css`**

Add after the existing `:root` block, before the `@media (prefers-reduced-motion)` rule:

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

Keep the existing `:root` properties (color-scheme, font, background) and merge — don't duplicate the selector. Combine into one `:root` block.

- [ ] **Step 2: Add keyframe animations to `styles.css`**

After the custom properties, add:

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

- [ ] **Step 3: Update `tailwind.config.ts`**

Replace the existing `theme.extend` block with:

```ts
theme: {
  extend: {
    colors: {
      ink: '#0f172a',
      mist: '#e2e8f0',
      ember: '#f97316',
      sea: '#0f766e'
    },
    boxShadow: {
      panel: '0 20px 50px -30px rgba(15, 23, 42, 0.55)'
    },
    screens: {
      'sm': '768px',
      'md': '1024px'
    },
    transitionDuration: {
      'instant': '75ms',
      'expressive': '600ms'
    },
    transitionTimingFunction: {
      'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      'spring-gentle': 'cubic-bezier(0.22, 1.2, 0.36, 1)'
    },
    animation: {
      'fade-in-up': 'fade-in-up 250ms cubic-bezier(0, 0, 0.2, 1)',
      'fade-in': 'fade-in 300ms cubic-bezier(0, 0, 0.2, 1)',
      'slide-in-left': 'slide-in-left 400ms cubic-bezier(0.22, 1.2, 0.36, 1)',
      'slide-in-right': 'slide-in-right 400ms cubic-bezier(0.22, 1.2, 0.36, 1)',
      'slide-in-up': 'slide-in-up 400ms cubic-bezier(0.22, 1.2, 0.36, 1)',
      'scale-in': 'scale-in 200ms cubic-bezier(0, 0, 0.2, 1)',
      'pulse-dot': 'pulse-dot 1.5s ease-in-out infinite',
      'border-flash-rose': 'border-flash-rose 400ms ease-out'
    }
  }
},
```

- [ ] **Step 4: Verify build compiles**

Run: `npm run typecheck`
Expected: No type errors

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add tailwind.config.ts renderer/styles.css
git commit -m "feat(ui): add responsive breakpoints, CSS custom properties, and animation keyframes"
```

---

### Task 2: Store — Add `sidebarOpen` State

**Files:**
- Modify: `renderer/store/app-store.ts`

- [ ] **Step 1: Add `sidebarOpen` and `toggleSidebar` to the store**

In the `AppStoreState` interface, after the `planDrawerOpen: boolean;` line, add:

```ts
sidebarOpen: boolean;
```

After the `togglePlanDrawer` method signature, add:

```ts
toggleSidebar: (open?: boolean) => void;
```

In the store defaults, after `planDrawerOpen: false,`, add:

```ts
sidebarOpen: typeof window !== 'undefined' ? window.matchMedia('(min-width: 1280px)').matches : false,
```

After the `togglePlanDrawer` implementation, add:

```ts
toggleSidebar: (open) => {
  set((state) => ({
    sidebarOpen: open ?? !state.sidebarOpen
  }));
},
```

- [ ] **Step 2: Add matchMedia listener in `loadInitialData`**

Inside the `loadInitialData` function, after the existing initialization code, add a media query listener. Find the end of the `loadInitialData` function body and add before its closing:

```ts
const mql = window.matchMedia('(min-width: 1280px)');
const handleResize = () => {
  const wide = mql.matches;
  set({ sidebarOpen: wide });
};
mql.addEventListener('change', handleResize);
```

This ensures the sidebar auto-opens when the window is widened past 1280px and auto-closes when narrowed below.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add renderer/store/app-store.ts
git commit -m "feat(ui): add sidebarOpen state and toggleSidebar to app store"
```

---

### Task 3: Sidebar — Overlay Mode & Responsive Rendering

**Files:**
- Modify: `renderer/components/sidebar.tsx`
- Modify: `renderer/pages/chat-page.tsx`

- [ ] **Step 1: Add `overlayMode` prop to Sidebar**

In `sidebar.tsx`, update `SidebarProps` to add:

```ts
overlayMode?: boolean;
onClose?: () => void;
```

Inside the `<aside>` root element, when `overlayMode` is true, add a close button at the top of the sidebar content area (before the existing header div). Insert this right after the opening `<aside>` tag:

```tsx
{props.overlayMode ? (
  <div className="flex items-center justify-end px-5 pt-3">
    <button
      aria-label="Close sidebar"
      className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
      onClick={props.onClose}
      type="button"
    >
      Close
    </button>
  </div>
) : null}
```

- [ ] **Step 2: Update ChatPage to render responsive sidebar layout**

In `chat-page.tsx`, add `sidebarOpen` and `toggleSidebar` to the store selectors near the other drawer selectors:

```ts
const sidebarOpen = useAppStore((state) => state.sidebarOpen);
const toggleSidebar = useAppStore((state) => state.toggleSidebar);
```

Replace the existing sidebar rendering block. Find this JSX:

```tsx
<Sidebar
  activeWorkspaceId={activeWorkspaceId}
  activeConversationId={activeConversationId}
  conversations={conversations}
  onSearchQueryChange={(query) => void setSearchQuery(query)}
  onSelectConversation={(conversationId) => {
    resetComposer();
    void selectConversation(conversationId);
  }}
  onSelectWorkspace={(workspaceId) => {
    resetComposer();
    void selectWorkspace(workspaceId);
  }}
  onDeleteWorkspace={(workspaceId) => void deleteWorkspace(workspaceId)}
  searchQuery={searchQuery}
  searchResults={searchResults}
  workspaces={workspaces}
/>
```

Replace with:

```tsx
{/* Inline sidebar — always visible at lg+ */}
<div className="hidden lg:block">
  <Sidebar
    activeWorkspaceId={activeWorkspaceId}
    activeConversationId={activeConversationId}
    conversations={conversations}
    onSearchQueryChange={(query) => void setSearchQuery(query)}
    onSelectConversation={(conversationId) => {
      resetComposer();
      void selectConversation(conversationId);
      if (window.innerWidth < 1280) toggleSidebar(false);
    }}
    onSelectWorkspace={(workspaceId) => {
      resetComposer();
      void selectWorkspace(workspaceId);
      if (window.innerWidth < 1280) toggleSidebar(false);
    }}
    onDeleteWorkspace={(workspaceId) => void deleteWorkspace(workspaceId)}
    searchQuery={searchQuery}
    searchResults={searchResults}
    workspaces={workspaces}
  />
</div>

{/* Overlay sidebar — visible when sidebarOpen at md and below */}
{sidebarOpen && (
  <>
    <div
      className="fixed inset-0 z-20 bg-slate-950/50 backdrop-blur-sm animate-fade-in lg:hidden"
      onClick={() => toggleSidebar(false)}
      role="presentation"
    />
    <aside className="fixed inset-y-0 left-0 z-30 w-80 animate-slide-in-left lg:hidden">
      <Sidebar
        overlayMode
        onClose={() => toggleSidebar(false)}
        activeWorkspaceId={activeWorkspaceId}
        activeConversationId={activeConversationId}
        conversations={conversations}
        onSearchQueryChange={(query) => void setSearchQuery(query)}
        onSelectConversation={(conversationId) => {
          resetComposer();
          void selectConversation(conversationId);
          toggleSidebar(false);
        }}
        onSelectWorkspace={(workspaceId) => {
          resetComposer();
          void selectWorkspace(workspaceId);
          toggleSidebar(false);
        }}
        onDeleteWorkspace={(workspaceId) => void deleteWorkspace(workspaceId)}
        searchQuery={searchQuery}
        searchResults={searchResults}
        workspaces={workspaces}
      />
    </aside>
  </>
)}
```

- [ ] **Step 3: Add Escape key handler for sidebar overlay**

In `chat-page.tsx`, add a `useEffect` that closes the sidebar on Escape:

```ts
useEffect(() => {
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && sidebarOpen) {
      toggleSidebar(false);
    }
  }
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [sidebarOpen, toggleSidebar]);
```

Add this after the existing `useEffect` hooks near the top of the component.

- [ ] **Step 4: Add hamburger toggle button to the header**

In the header section of `chat-page.tsx`, find the `<header>` element and add a hamburger button before the existing header content. Find this line:

```tsx
<div className="mx-auto flex w-full min-w-0 max-w-[88rem] flex-col gap-3">
```

Add a hamburger button inside that div, before the existing content:

```tsx
<div className="mx-auto flex w-full min-w-0 max-w-[88rem] flex-col gap-3">
  <div className="flex items-center gap-3">
    <button
      aria-expanded={sidebarOpen}
      aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
      className="lg:hidden flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
      onClick={() => toggleSidebar()}
      type="button"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
    <div className="min-w-0">
```

Close the new wrapper div after the existing header subtitle paragraph (the one with `title={headerSubtitle}`), before the search controls div:

```tsx
    </div>
  </div>
```

This wraps the eyebrow + title + subtitle in a flex row with the hamburger on narrow screens.

- [ ] **Step 5: Make header controls responsive**

In the header, find the `<div className="-mx-1 overflow-x-auto pb-1">` containing the action buttons and selects. Add responsive padding:

Change:
```tsx
<div className="-mx-1 overflow-x-auto pb-1">
```
To:
```tsx
<div className="-mx-1 overflow-x-auto pb-1 sm:gap-2">
```

For the selects container div (the one with `flex min-w-max items-center gap-3`), change to make it wrap on smaller screens:

Change:
```tsx
<div className="flex min-w-max items-center gap-3 px-1">
```
To:
```tsx
<div className="flex flex-wrap items-center gap-3 px-1">
```

Remove `min-w-max` to allow wrapping.

- [ ] **Step 6: Verify typecheck and build**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 7: Commit**

```bash
git add renderer/components/sidebar.tsx renderer/pages/chat-page.tsx
git commit -m "feat(ui): responsive sidebar with overlay mode and hamburger toggle"
```

---

### Task 4: Drawer Animations — Settings, Queue, Plan

**Files:**
- Modify: `renderer/components/settings-drawer.tsx`
- Modify: `renderer/components/queue-drawer.tsx`
- Modify: `renderer/components/plan-drawer.tsx`

- [ ] **Step 1: Animate SettingsDrawer**

In `settings-drawer.tsx`, the current backdrop div is:

```tsx
<div className="fixed inset-0 z-20 bg-slate-950/50 backdrop-blur-sm">
```

Change to:

```tsx
<div className="fixed inset-0 z-20 bg-slate-950/50 backdrop-blur-sm animate-fade-in">
```

The current panel aside has:

```tsx
<aside className="relative flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-slate-950 px-6 py-5 shadow-2xl">
```

Change to add the slide-in animation:

```tsx
<aside className="relative flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-slate-950 px-6 py-5 shadow-2xl animate-slide-in-right">
```

- [ ] **Step 2: Animate QueueDrawer**

In `queue-drawer.tsx`, the outer container is:

```tsx
<div className="pointer-events-none fixed inset-x-0 bottom-16 z-20 flex justify-center px-6">
```

Change to:

```tsx
<div className="pointer-events-none fixed inset-x-0 bottom-16 z-20 flex justify-center px-6 animate-fade-in">
```

The inner section:

```tsx
<section className="pointer-events-auto flex max-h-[calc(70vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur">
```

Change to add slide-up:

```tsx
<section className="pointer-events-auto flex max-h-[calc(70vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur animate-slide-in-up">
```

- [ ] **Step 3: Animate PlanDrawer**

In `plan-drawer.tsx`, same pattern. Outer container:

```tsx
<div className="pointer-events-none fixed inset-x-0 bottom-16 z-20 flex justify-center px-6">
```

Change to:

```tsx
<div className="pointer-events-none fixed inset-x-0 bottom-16 z-20 flex justify-center px-6 animate-fade-in">
```

Inner section:

```tsx
<section className="pointer-events-auto flex max-h-[calc(70vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur">
```

Change to:

```tsx
<section className="pointer-events-auto flex max-h-[calc(70vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur animate-slide-in-up">
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add renderer/components/settings-drawer.tsx renderer/components/queue-drawer.tsx renderer/components/plan-drawer.tsx
git commit -m "feat(ui): add slide-in animations to settings, queue, and plan drawers"
```

---

### Task 5: Message & Chat Animations

**Files:**
- Modify: `renderer/components/message-bubble.tsx`
- Modify: `renderer/components/message-list.tsx`
- Modify: `renderer/components/chat-composer.tsx`

- [ ] **Step 1: Add entrance animation to MessageBubble**

In `message-bubble.tsx`, find the `<article>` root element:

```tsx
<article
  className={`min-w-0 overflow-hidden rounded-[1.75rem] border px-5 py-4 shadow-panel ${
```

Add `animate-fade-in-up` to the class string. Change to:

```tsx
<article
  className={`animate-fade-in-up min-w-0 overflow-hidden rounded-[1.75rem] border px-5 py-4 shadow-panel ${
```

- [ ] **Step 2: Add responsive padding to MessageList**

In `message-list.tsx`, find the `<section>` element with:

```tsx
className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-6"
```

Change to:

```tsx
className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-6 sm:px-6"
```

This reduces horizontal padding on narrow windows.

- [ ] **Step 3: Add responsive padding to ChatComposer**

In `chat-composer.tsx`, find the `<form>` element:

```tsx
className="border-t border-white/10 bg-slate-950/70 px-6 py-4 backdrop-blur"
```

Change to:

```tsx
className="border-t border-white/10 bg-slate-950/70 px-4 py-4 backdrop-blur sm:px-6"
```

- [ ] **Step 4: Add responsive submit button text**

In `chat-composer.tsx`, find the submit button text logic. The current button shows different text based on state. For the send/generate/resend button, wrap the text content with responsive classes. Find:

```tsx
{props.submitting
  ? visibleSubmitLabel
  : props.generationMode
    ? 'Generate'
    : props.editing
      ? 'Resend'
      : 'Send'}
```

This remains as-is since the button text is short enough. No change needed for this step — "Send", "Generate", and "Resend" are already short.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add renderer/components/message-bubble.tsx renderer/components/message-list.tsx renderer/components/chat-composer.tsx
git commit -m "feat(ui): add message entrance animation and responsive padding"
```

---

### Task 6: Status Bar & Micro-Interaction Polish

**Files:**
- Modify: `renderer/components/status-bar.tsx`
- Modify: `renderer/styles.css`

- [ ] **Step 1: Add transition classes to ConnectionPill**

In `status-bar.tsx`, find the `ConnectionPill` component's root div:

```tsx
<div
  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
    props.healthy
      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
      : 'border-rose-400/30 bg-rose-400/10 text-rose-100'
  }`}
>
```

Add transition classes for smooth state changes:

```tsx
<div
  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors duration-150 ${
    props.healthy
      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
      : 'border-rose-400/30 bg-rose-400/10 text-rose-100'
  }`}
>
```

- [ ] **Step 2: Add responsive pill detail collapsing**

In `ConnectionPill`, the detail text is always shown. Make it responsive:

```tsx
<span className="text-[11px] opacity-80">{props.detail}</span>
```

Change to hide on small screens and show a tooltip:

```tsx
<span className="text-[11px] opacity-80 hidden sm:inline">{props.detail}</span>
```

This hides the detail text below 768px, keeping just the label + health dot visible on compact windows.

- [ ] **Step 3: Add transition enhancement to global styles**

In `styles.css`, add a utility class for dropdown menus and popovers after the keyframes block:

```css
.animate-dropdown {
  animation: scale-in 200ms cubic-bezier(0, 0, 0.2, 1);
}
```

- [ ] **Step 4: Enhance button hover transitions**

In `styles.css`, add a global button transition rule after the `button, input, select, textarea` block:

```css
button,
input,
select,
textarea {
  font: inherit;
  transition-property: background-color, border-color, color, opacity;
  transition-duration: 150ms;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
}
```

This replaces the bare `font: inherit` rule. The `transition` class on buttons will still work (it adds `transition: all 150ms`), but this provides a consistent baseline.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add renderer/components/status-bar.tsx renderer/styles.css
git commit -m "feat(ui): responsive status bar and micro-interaction transitions"
```

---

### Task 7: Thinking Block & Collapsible Animations

**Files:**
- Modify: `renderer/components/message-bubble.tsx`

- [ ] **Step 1: Add expand/collapse animation to ThinkingBlock**

In `message-bubble.tsx`, the `ThinkingBlock` component currently uses conditional rendering for open/close. Change it to use CSS transitions for smooth expand/collapse.

Find the `ThinkingBlock` component's return statement. Currently:

```tsx
<section className="rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3">
  ...
  {open ? (
    <div className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-300">
      {props.content}
    </div>
  ) : null}
</section>
```

Change to use max-height transition:

```tsx
<section className="rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 transition-colors duration-150">
  ...
  <div
    className="overflow-hidden transition-all duration-300 ease-spring-gentle"
    style={{ maxHeight: open ? '9999px' : '0', opacity: open ? 1 : 0 }}
  >
    <div className="whitespace-pre-wrap pb-2 text-sm leading-7 text-slate-300">
      {props.content}
    </div>
  </div>
</section>
```

- [ ] **Step 2: Add expand/collapse animation to MetadataSection**

Same pattern. The `MetadataSection` component renders children conditionally:

```tsx
{open ? <div className="mt-3">{props.children}</div> : null}
```

Change to:

```tsx
<div
  className="overflow-hidden transition-all duration-300 ease-spring-gentle"
  style={{ maxHeight: open ? '9999px' : '0', opacity: open ? 1 : 0 }}
>
  <div className="mt-3">{props.children}</div>
</div>
```

- [ ] **Step 3: Add expand/collapse animation to ToolInvocationCard**

The `ToolInvocationCard` conditionally renders output:

```tsx
{open && invocation.outputText ? (
  <div className="mt-3 rounded-2xl ...">
    <MarkdownContent content={invocation.outputText} />
  </div>
) : null}
```

Change to:

```tsx
{invocation.outputText ? (
  <div
    className="overflow-hidden transition-all duration-300 ease-spring-gentle"
    style={{ maxHeight: open ? '9999px' : '0', opacity: open ? 1 : 0 }}
  >
    <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/70 px-3 py-3">
      <MarkdownContent content={invocation.outputText} />
    </div>
  </div>
) : null}
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add renderer/components/message-bubble.tsx
git commit -m "feat(ui): add expand/collapse animations to thinking blocks and metadata sections"
```

---

### Task 8: Full Build & Manual Smoke Test

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No lint errors (or only pre-existing ones)

- [ ] **Step 3: Run tests**

Run: `npm run test`
Expected: All tests pass

- [ ] **Step 4: Run production build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Manual smoke test checklist**

Run: `npm run dev`

Verify:
1. At ≥1280px: sidebar visible inline, no hamburger button
2. At 1024–1279px: sidebar hidden, hamburger visible, click opens overlay with slide animation
3. At 768–1023px: same overlay behavior, header controls wrap
4. Clicking backdrop or pressing Escape closes sidebar overlay
5. Settings drawer slides in from right with animation
6. Queue drawer slides up with animation
7. Plan drawer slides up with animation
8. New message bubbles fade in with slight upward motion
9. Thinking block expand/collapse animates smoothly
10. Connection pills transition colors when health state changes
11. All existing functionality still works (chat, image gen, settings)

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(ui): responsive and animation polish fixes from smoke test"
```