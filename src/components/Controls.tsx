import { useCallback, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VOLUME_CHOICES, type VolumeChoice } from "@/lib/gameState";

export interface ControlsProps {
  tradeVolumeUsd: number;
  onSetVolume: (v: VolumeChoice) => void;
  onBuy: () => void;
  onSell: () => void;
  onFastForward: (minutes: number) => void;
  onEnd: () => void;
  showVolume: boolean;
  onToggleVolume: (v: boolean) => void;
  disabled: boolean;
  /**
   * When this string changes, pulse the button identified by the prefix before "#".
   * Recognized prefixes: any FF label ('5m', '15m', ...), 'BUY', 'SELL'.
   */
  pulseLabel?: string | null;
}

interface FfDef {
  label: string;
  minutes: number;
  hotkey: string;
}

const FF_ROW1: FfDef[] = [
  { label: "5m", minutes: 5, hotkey: "↓" },
  { label: "15m", minutes: 15, hotkey: "Shift+↓" },
  { label: "30m", minutes: 30, hotkey: "Ctrl+↓" },
];

const FF_ROW2: FfDef[] = [
  { label: "1h", minutes: 60, hotkey: "→ / PgDn" },
  { label: "4h", minutes: 240, hotkey: "Shift+→" },
  { label: "12h", minutes: 720, hotkey: "Ctrl+→" },
  { label: "1d", minutes: 1440, hotkey: "Enter" },
];

export function Controls(props: ControlsProps) {
  const ffRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const buyRef = useRef<HTMLButtonElement | null>(null);
  const sellRef = useRef<HTMLButtonElement | null>(null);

  const pulse = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    el.animate(
      [
        { boxShadow: "0 0 0 0 var(--ring)", transform: "scale(1)" },
        { boxShadow: "0 0 0 10px transparent", transform: "scale(1.06)" },
        { boxShadow: "0 0 0 10px transparent", transform: "scale(1)" },
      ],
      { duration: 380, easing: "cubic-bezier(.2,.9,.2,1)" },
    );
  }, []);

  useEffect(() => {
    if (!props.pulseLabel) return;
    const label = props.pulseLabel.split("#")[0];
    if (label === "BUY") pulse(buyRef.current);
    else if (label === "SELL") pulse(sellRef.current);
    else pulse(ffRefs.current[label]);
  }, [props.pulseLabel, pulse]);

  const onFf = (label: string, minutes: number) => {
    pulse(ffRefs.current[label]);
    props.onFastForward(minutes);
  };

  const onBuyClick = () => {
    pulse(buyRef.current);
    props.onBuy();
  };
  const onSellClick = () => {
    pulse(sellRef.current);
    props.onSell();
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-2">
        {/* Buy / Sell */}
        <div className="grid grid-cols-2 gap-0">
          <Button
            ref={buyRef}
            size="sm"
            variant="default"
            className="bg-[color:var(--gain)] text-white hover:bg-[color:var(--gain)]/90 h-7 gap-1.5 px-2 text-xs font-bold rounded-none"
            onClick={onBuyClick}
            disabled={props.disabled}
            data-testid="btn-buy"
          >
            <span>BUY</span>
            <span className="text-[9px] font-normal opacity-80">B</span>
          </Button>
          <Button
            ref={sellRef}
            size="sm"
            variant="default"
            className="bg-[color:var(--loss)] text-white hover:bg-[color:var(--loss)]/90 h-7 gap-1.5 px-2 text-xs font-bold rounded-none"
            onClick={onSellClick}
            disabled={props.disabled}
          >
            <span>SELL</span>
            <span className="text-[9px] font-normal opacity-80">S</span>
          </Button>
        </div>

        {/* Volume */}
        <div className="flex items-center gap-0 border-t border-border">
          <Select
            value={String(props.tradeVolumeUsd)}
            onValueChange={(v) => props.onSetVolume(Number(v) as VolumeChoice)}
          >
            <SelectTrigger
              className="h-6 flex-1 text-[10px] border-0 rounded-none"
              id="vol-select"
              onKeyDown={(e) => {
                if (
                  e.key === "ArrowDown" ||
                  e.key === "ArrowUp" ||
                  e.key === "ArrowLeft" ||
                  e.key === "ArrowRight" ||
                  e.key === "PageDown" ||
                  e.key === "PageUp" ||
                  e.key === "Enter"
                ) {
                  e.stopPropagation();
                }
              }}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VOLUME_CHOICES.map((v) => (
                <SelectItem key={v} value={String(v)}>
                  ${v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-0.5 text-[10px] text-muted-foreground px-2 whitespace-nowrap border-l border-border">
            <input
              type="checkbox"
              className="h-3 w-3 accent-[color:var(--ring)]"
              checked={props.showVolume}
              onChange={(e) => props.onToggleVolume(e.target.checked)}
            />
            Vol
          </label>
        </div>

        {/* Row 1: 5m, 15m, 30m */}
        <div className="grid grid-cols-3 gap-0 border-t border-border">
          {FF_ROW1.map((b) => (
            <Tooltip key={b.label}>
              <TooltipTrigger asChild>
                <Button
                  ref={(el) => {
                    ffRefs.current[b.label] = el;
                  }}
                  size="sm"
                  variant="secondary"
                  className="h-6 px-0 text-[10px] rounded-none border-r border-border last:border-r-0"
                  onClick={() => onFf(b.label, b.minutes)}
                  disabled={props.disabled}
                >
                  {b.label}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hotkey: {b.hotkey}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        {/* Row 2: 1h, 4h, 12h, 1d */}
        <div className="grid grid-cols-4 gap-0 border-t border-border">
          {FF_ROW2.map((b) => (
            <Tooltip key={b.label}>
              <TooltipTrigger asChild>
                <Button
                  ref={(el) => {
                    ffRefs.current[b.label] = el;
                  }}
                  size="sm"
                  variant="secondary"
                  className="h-6 px-0 text-[10px] rounded-none border-r border-border last:border-r-0"
                  onClick={() => onFf(b.label, b.minutes)}
                  disabled={props.disabled}
                >
                  {b.label}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hotkey: {b.hotkey}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="border-t border-border pt-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-full text-xs text-muted-foreground"
                onClick={props.onEnd}
                disabled={props.disabled}
              >
                End game
              </Button>
            </TooltipTrigger>
            <TooltipContent>Hotkey: Esc</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
