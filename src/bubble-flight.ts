/** Keep a bubble's rise speed stable when a drag changes the remaining distance. */
export function riseSpeed(startY: number, endY: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.abs(endY - startY) / durationMs;
}

/** Convert the current distance back into a duration at the original rise speed. */
export function remainingRiseMs(startY: number, endY: number, pixelsPerMs: number, fallbackMs: number): number {
  const distance = Math.abs(endY - startY);
  if (distance === 0) return 0;
  if (!Number.isFinite(pixelsPerMs) || pixelsPerMs <= 0) return fallbackMs;
  return distance / pixelsPerMs;
}
