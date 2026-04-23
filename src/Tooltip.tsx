import { useState, useRef } from 'react';
import { useFloating, offset, flip, shift, arrow } from '@floating-ui/react';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  title?: string;
}

export function Tooltip({ content, children, onClick, className, title }: TooltipProps) {
  const [isMounted, setIsMounted] = useState(false);
  const arrowRef = useRef<HTMLDivElement>(null);
  const showTimeoutRef = useRef<number | undefined>(undefined);
  const hideTimeoutRef = useRef<number | undefined>(undefined);

  const { refs, floatingStyles, placement, middlewareData } = useFloating({
    placement: 'top',
    middleware: [
      offset(12),
      flip(),
      shift({ padding: 8 }),
      arrow({
        element: arrowRef,
        padding: 14,
      }),
    ],
  });

  // Tooltip above target = arrow points down (top placement)
  // Tooltip below target = arrow points up (bottom placement)
  const isTop = placement === 'top' || placement === 'top-start' || placement === 'top-end';
  const { arrow: arrowData } = middlewareData;

  const handleMouseEnter = () => {
    clearTimeout(hideTimeoutRef.current);
    showTimeoutRef.current = window.setTimeout(() => {
      setIsMounted(true);
    }, 150);
  };

  const handleMouseLeave = () => {
    clearTimeout(showTimeoutRef.current);
    hideTimeoutRef.current = window.setTimeout(() => {
      setIsMounted(false);
    }, 150);
  };

  return (
    <>
      <div
        ref={refs.setReference}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={onClick}
        title={title}
        className={className || 'tooltip-trigger action-btn'}
        style={{ display: 'inline-flex', width: 'auto', padding: '0 8px', cursor: onClick ? 'pointer' : undefined }}
      >
        {children}
      </div>
      
      {isMounted && (
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className="tooltip-floating"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="tooltip-content">{content}</div>
          <div
            ref={arrowRef}
            className={`tooltip-arrow ${isTop ? 'tooltip-arrow-down' : 'tooltip-arrow-up'}`}
            style={{
              left: arrowData?.x,
              top: arrowData?.y,
            }}
          />
        </div>
      )}
    </>
  );
}
