import { useEffect, useRef } from 'react';
import {
    createChart,
    CandlestickSeries,
    HistogramSeries,
    CrosshairMode,
    type IChartApi,
    type ISeriesApi,
    type UTCTimestamp,
    type CandlestickData,
    type HistogramData,
} from 'lightweight-charts';

import type { Candle } from '@/lib/victoriametrics';

export interface ChartProps {
    /** Candles up to and including the current cursor. */
    candles: Candle[];
    /** First bar's epoch (used to display offset times). */
    originSec: number;
    /** Multiplier dividing real prices to get displayed (normalized when blinded). */
    normFactor: number;
    showVolume: boolean;
    dark: boolean;
    /** When true, the time axis shows real wall-clock dates instead of elapsed offsets. */
    absoluteTime?: boolean;
    /** Color the live/current candle against the last user-visible price jump. */
    lastDeltaPct?: number;
}

function formatElapsed(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    const days = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (days > 0) return `${days}d ${String(h).padStart(2, '0')}h`;
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
    if (m > 0) return `${m}m${String(sec).padStart(2, '0')}`;
    return `${sec}s`;
}

function formatAbsolute(seconds: number): string {
    const d = new Date(seconds * 1000);
    const m = d.getMonth() + 1;
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${m}/${dd} ${hh}:${mi}`;
}

export function Chart({ candles, originSec, normFactor, showVolume, dark, absoluteTime = false, lastDeltaPct = 0 }: ChartProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

    // Init once (or when key formatting inputs change).
    useEffect(() => {
        if (!containerRef.current) return;
        const text = dark ? '#cbd5e1' : '#334155';
        const grid = dark ? 'rgba(148,163,184,0.08)' : 'rgba(100,116,139,0.10)';
        const bg = 'transparent';
        const fmtTime = (t: number) => (absoluteTime ? formatAbsolute(t) : formatElapsed(t - originSec));
        const chart = createChart(containerRef.current, {
            layout: { background: { color: bg }, textColor: text, fontFamily: 'Inter, system-ui, sans-serif' },
            grid: { vertLines: { color: grid }, horzLines: { color: grid } },
            rightPriceScale: { borderVisible: false },
            timeScale: {
                borderVisible: false,
                timeVisible: true,
                secondsVisible: !absoluteTime,
                tickMarkFormatter: fmtTime,
            },
            crosshair: { mode: CrosshairMode.Normal },
            localization: {
                timeFormatter: fmtTime,
                priceFormatter: (p: number) => p.toFixed(2),
            },
            autoSize: true,
        });
        const candle = chart.addSeries(CandlestickSeries, {
            upColor: '#16a34a',
            downColor: '#dc2626',
            wickUpColor: '#16a34a',
            wickDownColor: '#dc2626',
            borderVisible: false,
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        });
        const vol = chart.addSeries(HistogramSeries, {
            priceFormat: { type: 'volume' },
            priceScaleId: 'vol',
            color: dark ? 'rgba(148,163,184,0.4)' : 'rgba(100,116,139,0.4)',
                                    lastValueVisible: false,
                                    priceLineVisible: false,
        });
        vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        chartRef.current = chart;
        candleSeriesRef.current = candle;
        volSeriesRef.current = vol;
        return () => {
            chart.remove();
            chartRef.current = null;
            candleSeriesRef.current = null;
            volSeriesRef.current = null;
        };
    }, [originSec, dark, absoluteTime]);

    // Data updates.
    useEffect(() => {
        const candle = candleSeriesRef.current;
        const vol = volSeriesRef.current;
        if (!candle || !vol) return;
        // Color each candle relative to the PREVIOUS candle's close, so what the
        // user sees ("price went up/down from the last bar I saw") matches the color.
        const up = '#16a34a';
        const down = '#dc2626';
    const cData: CandlestickData<UTCTimestamp>[] = candles.map((c, i) => {
        const prevClose = i > 0 ? candles[i - 1].close : c.open;
        const isCurrent = !absoluteTime && i === candles.length - 1 && candles.length > 1 && lastDeltaPct !== 0;
        const isUp = isCurrent ? lastDeltaPct > 0 : c.close >= prevClose;
        const color = isUp ? up : down;
        return {
            time: c.time as UTCTimestamp,
            open: c.open / normFactor,
            high: c.high / normFactor,
            low: c.low / normFactor,
            close: c.close / normFactor,
            color,
            wickColor: color,
            borderColor: color,
        };
    });
    const vData: HistogramData<UTCTimestamp>[] = candles.map((c, i) => {
        const prevClose = i > 0 ? candles[i - 1].close : c.open;
        const isCurrent = !absoluteTime && i === candles.length - 1 && candles.length > 1 && lastDeltaPct !== 0;
        const isUp = isCurrent ? lastDeltaPct > 0 : c.close >= prevClose;
        return {
            time: c.time as UTCTimestamp,
            value: c.volume,
            color: isUp ? 'rgba(22,163,74,0.5)' : 'rgba(220,38,38,0.5)',
        };
    });
    candle.setData(cData);
    vol.setData(vData);
    }, [candles, normFactor, absoluteTime, lastDeltaPct]);

    // Toggle volume visibility.
    useEffect(() => {
        const vol = volSeriesRef.current;
        if (!vol) return;
        vol.applyOptions({ visible: showVolume });
    }, [showVolume]);

    return <div ref={containerRef} className='h-full w-full' />;
}
