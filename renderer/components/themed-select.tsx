import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from 'react';
import { createPortal } from 'react-dom';

export interface ThemedSelectOption {
  value: string;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
}

interface ThemedSelectProps {
  ariaLabel: string;
  value: string;
  options: ThemedSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  size?: 'default' | 'compact';
  placement?: 'bottom' | 'top';
  className?: string | undefined;
}

interface MenuPosition {
  left: number;
  width: number;
  maxHeight: number;
  placement: 'bottom' | 'top';
  top?: number;
  bottom?: number;
}

function getEnabledIndex(
  options: ThemedSelectOption[],
  startIndex: number,
  direction: 1 | -1
) {
  if (options.length === 0) {
    return -1;
  }

  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (startIndex + offset * direction + options.length) % options.length;

    if (!options[index]?.disabled) {
      return index;
    }
  }

  return -1;
}

export function ThemedSelect({
  ariaLabel,
  className,
  disabled,
  onChange,
  options,
  placement = 'bottom',
  size = 'default',
  value
}: ThemedSelectProps) {
  const baseId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const selectedLabel = selectedOption?.label ?? 'Select an option';
  const listboxId = `${baseId}-listbox`;

  const optionIds = useMemo(
    () => options.map((_, index) => `${baseId}-option-${index}`),
    [baseId, options]
  );

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;

    if (!trigger || typeof window === 'undefined') {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const gap = 8;
    const viewportWidth = Math.max(window.innerWidth, 320);
    const viewportHeight = Math.max(window.innerHeight, 320);
    const minWidth = size === 'compact' ? 136 : 240;
    const width = Math.min(Math.max(rect.width, minWidth), viewportWidth - 16);
    const left = Math.min(Math.max(rect.left, 8), viewportWidth - width - 8);
    const belowSpace = viewportHeight - rect.bottom - gap;
    const aboveSpace = rect.top - gap;
    const shouldOpenTop =
      placement === 'top' || (belowSpace < 180 && aboveSpace > belowSpace);
    const availableSpace = shouldOpenTop ? aboveSpace : belowSpace;
    const maxHeight = Math.max(128, Math.min(288, availableSpace - 8));

    setMenuPosition({
      left,
      width,
      maxHeight,
      placement: shouldOpenTop ? 'top' : 'bottom',
      ...(shouldOpenTop
        ? { bottom: viewportHeight - rect.top + gap }
        : { top: rect.bottom + gap })
    });
  }, [placement, size]);

  const openMenu = useCallback(
    (preferredIndex?: number) => {
      if (disabled) {
        return;
      }

      updatePosition();
      const fallbackIndex =
        selectedIndex >= 0 ? selectedIndex : getEnabledIndex(options, 0, 1);
      const nextIndex =
        preferredIndex !== undefined && !options[preferredIndex]?.disabled
          ? preferredIndex
          : fallbackIndex;

      setActiveIndex(nextIndex);
      setOpen(true);
    },
    [disabled, options, selectedIndex, updatePosition]
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    updatePosition();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;

      if (
        target &&
        (triggerRef.current?.contains(target) || menuRef.current?.contains(target))
      ) {
        return;
      }

      setOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  function selectOption(option: ThemedSelectOption) {
    if (option.disabled) {
      return;
    }

    onChange(option.value);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIndex = open
        ? getEnabledIndex(options, activeIndex + 1, 1)
        : getEnabledIndex(options, selectedIndex + 1, 1);
      openMenu(nextIndex);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const nextIndex = open
        ? getEnabledIndex(options, activeIndex - 1, -1)
        : getEnabledIndex(options, selectedIndex - 1, -1);
      openMenu(nextIndex);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();

      if (open && activeIndex >= 0) {
        const option = options[activeIndex];

        if (option) {
          selectOption(option);
        }

        return;
      }

      openMenu();
      return;
    }

    if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  const menuStyle: CSSProperties | undefined = menuPosition
    ? {
        left: menuPosition.left,
        width: menuPosition.width,
        maxHeight: menuPosition.maxHeight,
        top: menuPosition.top,
        bottom: menuPosition.bottom
      }
    : undefined;

  const menu =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            className={`themed-select__menu themed-select__menu--${menuPosition?.placement ?? placement} motion-menu-pop`}
            id={listboxId}
            ref={menuRef}
            role="listbox"
            style={menuStyle}
          >
            {options.map((option, index) => {
              const selected = option.value === value;
              const active = index === activeIndex;

              return (
                <button
                  aria-selected={selected}
                  className={`themed-select__option${
                    selected ? ' themed-select__option--selected' : ''
                  }${active ? ' themed-select__option--active' : ''}`}
                  disabled={option.disabled}
                  id={optionIds[index]}
                  key={`${option.value}-${index}`}
                  onClick={() => selectOption(option)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    if (!option.disabled) {
                      setActiveIndex(index);
                    }
                  }}
                  role="option"
                  type="button"
                >
                  <span className="themed-select__option-label">{option.label}</span>
                  {option.description ? (
                    <span className="themed-select__option-description">
                      {option.description}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>,
          document.body
        )
      : null;

  return (
    <div className={`themed-select themed-select--${size}${className ? ` ${className}` : ''}`}>
      <button
        aria-activedescendant={open && activeIndex >= 0 ? optionIds[activeIndex] : undefined}
        aria-controls={open ? listboxId : undefined}
        aria-disabled={disabled ? 'true' : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="themed-select__trigger motion-interactive"
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }

          openMenu();
        }}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <span className="themed-select__value">{selectedLabel}</span>
        <span aria-hidden="true" className="themed-select__chevron" />
      </button>
      {menu}
    </div>
  );
}
