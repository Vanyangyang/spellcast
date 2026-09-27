/** Offsets are UTF-16 positions in the exact `GameDocument.text` string. */
export type TextRange = { start: number; end: number };

export function mergeTextRanges(ranges: TextRange[], length: number): TextRange[] {
  const sorted = ranges.map(({ start, end }) => ({ start: Math.max(0, Math.min(length, Math.trunc(start))), end: Math.max(0, Math.min(length, Math.trunc(end))) }))
    .filter(range => range.end > range.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function removeTextRange(ranges: TextRange[], removed: TextRange, length: number): TextRange[] {
  return mergeTextRanges(ranges.flatMap(range => {
    if (removed.end <= range.start || removed.start >= range.end) return [range];
    return [{ start: range.start, end: Math.min(removed.start, range.end) }, { start: Math.max(removed.end, range.start), end: range.end }];
  }), length);
}

export function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < Math.min(offset, text.length); i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function rangeFragment(text: string, range: TextRange): string {
  return `#L${lineOfOffset(text, range.start)}-L${lineOfOffset(text, Math.max(range.start, range.end - 1))}@${range.start}-${range.end}`;
}

export function parseRangeFragment(uri: string): TextRange | null {
  const match = uri.match(/#L\d+-L\d+@(\d+)-(\d+)$/);
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start ? { start, end } : null;
}
