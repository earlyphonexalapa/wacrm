"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CornerUpLeft, Copy, SmilePlus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Message } from "@/types";
import { useTranslations } from "next-intl";

// WhatsApp's own quick-reaction bar starts with these six. Picking the same
// set keeps the affordance familiar without pulling in a 300KB emoji library.
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// How far (px) a bubble must be swiped right before letting go replies to it.
const SWIPE_REPLY_THRESHOLD = 56;

interface MessageActionsProps {
  message: Message;
  onReply: () => void;
  onReact: (emoji: string) => void;
  children: ReactNode;
}

/**
 * Hover/long-press toolbar wrapper around a `<MessageBubble>`. The bubble
 * itself stays a pure presenter — this component owns the action surface so
 * the bubble's render path is unaffected when the toolbar isn't visible.
 */
export function MessageActions({
  message,
  onReply,
  onReact,
  children,
}: MessageActionsProps) {
  const t = useTranslations("Inbox.actions");

  // Touch devices have no hover. Long-press fires `contextmenu`; we capture
  // it, suppress the native menu, and pin the toolbar open until the user
  // interacts elsewhere.
  const [touchOpen, setTouchOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // iOS Safari never fires `contextmenu` on a long-press, so phones get a
  // hand-rolled one (hold ~0.45s → toolbar) plus WhatsApp's swipe-right-to-
  // reply: drag the bubble right past the threshold and let go.
  const rowRef = useRef<HTMLDivElement>(null);
  const [swipeX, setSwipeX] = useState(0);
  const touchRef = useRef<{
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout> | null;
    swiping: boolean;
    cancelled: boolean;
    longPressed: boolean;
  } | null>(null);

  const clearPressTimer = () => {
    if (touchRef.current?.timer) clearTimeout(touchRef.current.timer);
    if (touchRef.current) touchRef.current.timer = null;
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const t0 = e.touches[0];
    touchRef.current = {
      x: t0.clientX,
      y: t0.clientY,
      swiping: false,
      cancelled: false,
      longPressed: false,
      timer: setTimeout(() => {
        setTouchOpen(true);
        if (touchRef.current) {
          touchRef.current.cancelled = true;
          touchRef.current.longPressed = true;
        }
      }, 450),
    };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const s = touchRef.current;
    if (!s || s.cancelled) return;
    const dx = e.touches[0].clientX - s.x;
    const dy = e.touches[0].clientY - s.y;
    if (!s.swiping) {
      if (Math.abs(dy) > 10) {
        // Scrolling the thread — not a press, not a swipe.
        clearPressTimer();
        s.cancelled = true;
        return;
      }
      if (dx > 12 && Math.abs(dx) > Math.abs(dy)) {
        clearPressTimer();
        s.swiping = true;
      }
    }
    if (s.swiping) setSwipeX(Math.max(0, Math.min(dx, 80)));
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    clearPressTimer();
    const s = touchRef.current;
    // Lifting the finger after a long-press must not also count as a tap
    // (which would open an image or play an audio under the finger).
    if (s?.longPressed && e.cancelable) e.preventDefault();
    if (s?.swiping && swipeX >= SWIPE_REPLY_THRESHOLD) onReply();
    touchRef.current = null;
    setSwipeX(0);
  };

  // A pinned toolbar closes when the user taps anywhere else.
  useEffect(() => {
    if (!touchOpen) return;
    const onOutside = (e: Event) => {
      if (!rowRef.current?.contains(e.target as Node)) setTouchOpen(false);
    };
    document.addEventListener("touchstart", onOutside);
    document.addEventListener("mousedown", onOutside);
    return () => {
      document.removeEventListener("touchstart", onOutside);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [touchOpen]);

  const isAgent =
    message.sender_type === "agent" || message.sender_type === "bot";

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setTouchOpen(true);
  };

  const handleCopy = async () => {
    const text = message.content_text ?? "";
    if (!text) {
      toast.error(t("nothingToCopy"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
    setTouchOpen(false);
  };

  const handlePickEmoji = (emoji: string) => {
    onReact(emoji);
    setPickerOpen(false);
    setTouchOpen(false);
  };

  const handleReply = () => {
    onReply();
    setTouchOpen(false);
  };

  // Row alignment lives here (not in MessageBubble) so the `group/actions`
  // hover region matches the bubble's content width — hovering empty space
  // in the row no longer reveals the toolbar.
  return (
    <div
      ref={rowRef}
      className={cn(
        "relative flex w-full",
        isAgent ? "justify-end" : "justify-start",
      )}
      onContextMenu={handleContextMenu}
      onBlur={() => setTouchOpen(false)}
    >
      {/* Reply arrow that fades in behind a bubble being swiped. */}
      {swipeX > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-muted text-muted-foreground"
          style={{ opacity: Math.min(1, swipeX / SWIPE_REPLY_THRESHOLD) }}
        >
          <CornerUpLeft className="h-4 w-4" />
        </span>
      )}
      {/* `min-w-0` lets this flex child actually respect the 75% cap.
       *  Default `min-width: auto` lets content (a long quote preview,
       *  an unbroken URL) push past the cap and shove the row past
       *  100%, which used to bleed across into the contact-sidebar
       *  area. See issue #165. */}
      <div
        className="group/actions relative min-w-0 max-w-[85%] [-webkit-touch-callout:none] max-lg:select-none lg:max-w-[75%]"
        style={{
          transform: swipeX ? `translateX(${swipeX}px)` : undefined,
          transition: swipeX ? "none" : "transform 150ms ease-out",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {children}
      <div
        data-touch-open={touchOpen || pickerOpen ? "true" : undefined}
        className={cn(
          "absolute -top-3 z-10 flex h-7 items-center gap-0.5 rounded-full max-lg:-top-12 max-lg:h-11 max-lg:gap-1 max-lg:px-1.5 border border-border bg-popover/95 px-1 shadow-md backdrop-blur-sm transition-opacity",
          "opacity-0 group-hover/actions:opacity-100 group-focus-within/actions:opacity-100",
          "data-[touch-open=true]:opacity-100",
          isAgent ? "right-3" : "left-3",
        )}
      >
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground max-lg:h-9 max-lg:w-9 hover:bg-muted hover:text-foreground"
            aria-label={t("react")}
          >
            <SmilePlus className="h-3.5 w-3.5 max-lg:h-5 max-lg:w-5" />
          </PopoverTrigger>
          <PopoverContent
            className="flex w-auto flex-row gap-1 p-1.5"
            sideOffset={6}
          >
            {QUICK_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => handlePickEmoji(e)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-transform hover:scale-125 hover:bg-muted"
                aria-label={t("reactWith", { emoji: e })}
              >
                {e}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <button
          type="button"
          onClick={handleReply}
          className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground max-lg:h-9 max-lg:w-9 hover:bg-muted hover:text-foreground"
          aria-label={t("reply")}
        >
          <CornerUpLeft className="h-3.5 w-3.5 max-lg:h-5 max-lg:w-5" />
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground max-lg:h-9 max-lg:w-9 hover:bg-muted hover:text-foreground"
          aria-label={t("copyText")}
        >
          <Copy className="h-3.5 w-3.5 max-lg:h-5 max-lg:w-5" />
        </button>
      </div>
      </div>
    </div>
  );
}
