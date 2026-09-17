// Host-owned navigation, injected separately from the immutable work and its saved SDK.
(() => {
  if (parent === window) return;
  let port, enabled = false;
  addEventListener('message', event => {
    if (port || event.source !== parent || event.data?.type !== 'spellcast:init' || !event.ports?.[0]) return;
    port = event.ports[0];
    enabled = event.data.canvasWheel === true && event.data.readOnly !== true;
  });
  addEventListener('wheel', event => {
    if (!enabled || !port || !event.isTrusted || event.defaultPrevented ||
      !Number.isFinite(event.deltaY) || !event.deltaY || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target;
    if (target?.closest?.('select, input[type=range], input[type=number]')) return;
    for (let element = target; element; element = element.parentElement) {
      if (element.nodeType !== 1) continue;
      const style = getComputedStyle(element);
      const scrolls = /(auto|scroll)/.test(style.overflowY) ||
        (element === document.scrollingElement && !/(hidden|clip)/.test(style.overflowY));
      if (scrolls && element.scrollHeight > element.clientHeight + 1) return;
    }
    const x = event.clientX / window.innerWidth, y = event.clientY / window.innerHeight;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return;
    // Work handlers may still consume the event later in the same dispatch.
    setTimeout(() => {
      if (!event.defaultPrevented) port.postMessage({ type: 'wheel', value: { x, y, deltaY: Math.sign(event.deltaY) } });
    }, 0);
  }, { passive: true });
})();
