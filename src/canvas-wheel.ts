/** Keep the wheel with scrollable content, including at its boundaries, and native value controls. */
export function contentUsesWheel(target: Element, boundary: HTMLElement): boolean {
  if (target.closest("select, input[type=range], input[type=number]")) return true;
  for (let element: Element | null = target; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) return true;
    if (element === boundary) break;
  }
  return false;
}

/** Same stepped zoom at low scales for DOM content and sandbox wheel messages. */
export function wheelScale(scale: number, deltaY: number) {
  const zoomIn = deltaY < 0;
  const next = scale <= .15 ? scale + (zoomIn ? .01 : -.01) : Math.round(scale * (zoomIn ? 1.2 : 1 / 1.2) * 20) / 20;
  return Math.max(.01, Math.min(1.5, next));
}
