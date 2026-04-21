import { useEffect, useState } from 'react';

type MascotReaction = 'bounce' | 'glow' | 'tilt' | 'wobble' | 'squish';
type MascotPhase = 'moving' | 'hammering';

interface MascotTarget {
  selector: string;
  reaction: MascotReaction;
  anchor: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

interface MascotState {
  cycle: number;
  hitLeft: number;
  hitTop: number;
  left: number;
  phase: MascotPhase;
  reaction: MascotReaction;
  top: number;
}

interface StreamingMascotProps {
  active: boolean;
}

const TARGETS: MascotTarget[] = [
  {
    selector: '[data-mascot-target="streaming-message"]',
    reaction: 'bounce',
    anchor: 'top-right'
  },
  {
    selector: '[data-mascot-target="composer"]',
    reaction: 'squish',
    anchor: 'top-left'
  },
  {
    selector: '[data-mascot-target="status-bar"]',
    reaction: 'glow',
    anchor: 'top-left'
  },
  {
    selector: '[data-mascot-target="sidebar"]',
    reaction: 'tilt',
    anchor: 'center'
  }
];

const INITIAL_STATE: MascotState = {
  cycle: 0,
  hitLeft: 0,
  hitTop: 0,
  left: 24,
  phase: 'moving',
  reaction: 'bounce',
  top: 96
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getAnchorPoint(rect: DOMRect, anchor: MascotTarget['anchor']) {
  switch (anchor) {
    case 'top-left':
      return {
        x: rect.left + Math.min(88, rect.width * 0.35),
        y: rect.top + Math.min(34, rect.height * 0.45)
      };
    case 'top-right':
      return {
        x: rect.right - Math.min(88, rect.width * 0.28),
        y: rect.top + Math.min(34, rect.height * 0.45)
      };
    case 'bottom-left':
      return {
        x: rect.left + Math.min(88, rect.width * 0.35),
        y: rect.bottom - Math.min(34, rect.height * 0.45)
      };
    case 'bottom-right':
      return {
        x: rect.right - Math.min(88, rect.width * 0.28),
        y: rect.bottom - Math.min(34, rect.height * 0.45)
      };
    default:
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
  }
}

function isVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return (
    rect.width > 8 &&
    rect.height > 8 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0'
  );
}

function findTarget(target: MascotTarget) {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>(target.selector)
  );

  return elements.find(isVisible) ?? null;
}

function MascotFigure(props: { phase: MascotPhase }) {
  return (
    <div
      aria-hidden="true"
      className={`streaming-mascot__figure ${
        props.phase === 'hammering' ? 'streaming-mascot__figure--hit' : ''
      }`}
    >
      <div className="streaming-mascot__hat" />
      <div className="streaming-mascot__head">
        <span className="streaming-mascot__eye streaming-mascot__eye--left" />
        <span className="streaming-mascot__eye streaming-mascot__eye--right" />
        <span className="streaming-mascot__cheek streaming-mascot__cheek--left" />
        <span className="streaming-mascot__cheek streaming-mascot__cheek--right" />
        <span className="streaming-mascot__smile" />
      </div>
      <div className="streaming-mascot__body" />
      <div className="streaming-mascot__arm streaming-mascot__arm--left" />
      <div className="streaming-mascot__arm streaming-mascot__arm--right">
        <span className="streaming-mascot__hammer">
          <span className="streaming-mascot__hammer-head" />
          <span className="streaming-mascot__hammer-handle" />
        </span>
      </div>
      <div className="streaming-mascot__foot streaming-mascot__foot--left" />
      <div className="streaming-mascot__foot streaming-mascot__foot--right" />
    </div>
  );
}

export function StreamingMascot(props: StreamingMascotProps) {
  const [state, setState] = useState<MascotState>(INITIAL_STATE);

  useEffect(() => {
    if (!props.active) {
      setState(INITIAL_STATE);
      return;
    }

    let cancelled = false;
    let targetIndex = 0;
    let cycle = 0;
    const timeouts: number[] = [];
    const addTimeout = (callback: () => void, delay: number) => {
      const timeoutId = window.setTimeout(callback, delay);
      timeouts.push(timeoutId);
    };

    function scheduleNextVisit() {
      if (cancelled) {
        return;
      }

      let selectedTarget: MascotTarget | null = null;
      let selectedElement: HTMLElement | null = null;

      for (let attempt = 0; attempt < TARGETS.length; attempt += 1) {
        const target = TARGETS[targetIndex % TARGETS.length];
        targetIndex += 1;

        if (!target) {
          continue;
        }

        const element = findTarget(target);

        if (element) {
          selectedTarget = target;
          selectedElement = element;
          break;
        }
      }

      if (!selectedTarget || !selectedElement) {
        addTimeout(scheduleNextVisit, 900);
        return;
      }

      const rect = selectedElement.getBoundingClientRect();
      const point = getAnchorPoint(rect, selectedTarget.anchor);
      const nextLeft = clamp(point.x - 32, 12, window.innerWidth - 88);
      const nextTop = clamp(point.y - 74, 48, window.innerHeight - 110);
      cycle += 1;

      setState({
        cycle,
        hitLeft: point.x,
        hitTop: point.y,
        left: nextLeft,
        phase: 'moving',
        reaction: selectedTarget.reaction,
        top: nextTop
      });

      addTimeout(() => {
        if (cancelled || !selectedElement) {
          return;
        }

        const reactionClass = `mascot-hit-${selectedTarget.reaction}`;
        selectedElement.classList.add(reactionClass);

        setState({
          cycle,
          hitLeft: point.x,
          hitTop: point.y,
          left: nextLeft,
          phase: 'hammering',
          reaction: selectedTarget.reaction,
          top: nextTop
        });

        addTimeout(() => {
          selectedElement?.classList.remove(reactionClass);
        }, 720);
      }, 680);

      addTimeout(scheduleNextVisit, 1700);
    }

    addTimeout(scheduleNextVisit, 120);

    return () => {
      cancelled = true;
      timeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
      document
        .querySelectorAll<HTMLElement>(
          '.mascot-hit-bounce, .mascot-hit-glow, .mascot-hit-tilt, .mascot-hit-wobble, .mascot-hit-squish'
        )
        .forEach((element) => {
          element.classList.remove(
            'mascot-hit-bounce',
            'mascot-hit-glow',
            'mascot-hit-tilt',
            'mascot-hit-wobble',
            'mascot-hit-squish'
          );
        });
    };
  }, [props.active]);

  if (!props.active) {
    return null;
  }

  return (
    <>
      <div
        aria-hidden="true"
        className="streaming-mascot"
        style={{
          left: `${state.left}px`,
          top: `${state.top}px`
        }}
      >
        <MascotFigure phase={state.phase} />
      </div>
      {state.phase === 'hammering' ? (
        <div
          aria-hidden="true"
          className={`mascot-impact mascot-impact--${state.reaction}`}
          key={state.cycle}
          style={{
            left: `${state.hitLeft}px`,
            top: `${state.hitTop}px`
          }}
        >
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : null}
    </>
  );
}
