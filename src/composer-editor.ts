import { currentLocale, onLocale } from "./i18n";

/** Presentation only: resizing never changes the draft, selection or delivery target. */
export function mountComposerEditor(composer: HTMLElement, input: HTMLTextAreaElement, toggle: HTMLButtonElement) {
  let expanded = false;
  let manualHeight: number | undefined;
  let appliedHeight = 0;
  let scheduled = 0;
  let revealAt: number | undefined;
  const designMenu = composer.querySelector<HTMLDetailsElement>("#canvas-game-design");

  function paintToggle() {
    const zh = currentLocale() === "zh-CN";
    toggle.textContent = expanded ? (zh ? "收起输入" : "Collapse input") : (zh ? "展开输入" : "Expand input");
    toggle.setAttribute("aria-label", toggle.textContent);
    toggle.title = zh ? "聚焦时自动展开；可拖动输入框右下角调整高度。Esc 收起并保留草稿。" : "Expands on focus. Drag the lower-right corner to resize. Esc collapses and keeps the draft.";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.disabled = input.disabled;
    composer.classList.toggle("is-editing", expanded);
  }

  function resize() {
    scheduled = 0;
    paintToggle();
    if (!composer.getClientRects().length) return;
    const viewport = window.visualViewport;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const viewportBottom = (viewport?.offsetTop ?? 0) + viewportHeight;
    const top = document.querySelector<HTMLElement>(".top")?.getBoundingClientRect().bottom ?? 0;
    const chromeHeight = composer.getBoundingClientRect().height - input.getBoundingClientRect().height;
    const bottomGap = Math.max(12, window.innerHeight - composer.getBoundingClientRect().bottom);
    const limit = Math.max(56, Math.floor(Math.min(480, viewportHeight * .52, viewportBottom - top - chromeHeight - bottomGap - 24)));
    const minimum = expanded ? Math.min(168, limit) : Math.min(56, limit);
    const previousScroll = input.scrollTop;
    const style = getComputedStyle(input);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    input.style.minHeight = "0px";
    input.style.height = "0px";
    const contentHeight = input.scrollHeight + border;
    const height = expanded ? Math.min(limit, Math.max(minimum, manualHeight ?? contentHeight)) : minimum;
    input.style.minHeight = `${minimum}px`;
    input.style.maxHeight = `${limit}px`;
    input.style.height = `${height}px`;
    appliedHeight = height;
    input.scrollTop = previousScroll;

    if (designMenu?.open) {
      const summary = designMenu.querySelector("summary")!;
      const panel = designMenu.querySelector<HTMLElement>(".composer-game-design-panel")!;
      const anchor = summary.getBoundingClientRect();
      const below = viewportBottom - anchor.bottom - 19;
      const above = anchor.top - Math.max(top, viewport?.offsetTop ?? 0) - 19;
      const down = below > above;
      panel.style.top = down ? "calc(100% + 7px)" : "auto";
      panel.style.bottom = down ? "auto" : "calc(100% + 7px)";
      panel.style.maxHeight = `${Math.max(0, Math.min(300, down ? below : above))}px`;
      const width = panel.getBoundingClientRect().width;
      const left = Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12));
      panel.style.right = `${anchor.right - left - width}px`;
    }

    if (revealAt !== undefined) {
      // Locate the newly appended request without moving the user's caret to its last hash.
      const offset = revealAt;
      revealAt = undefined;
      const mirror = document.createElement("div");
      Object.assign(mirror.style, { position: "fixed", visibility: "hidden", pointerEvents: "none", whiteSpace: "pre-wrap", overflowWrap: "break-word", boxSizing: "border-box", width: `${input.clientWidth}px`, font: style.font, letterSpacing: style.letterSpacing, padding: style.padding, border: "0" });
      mirror.textContent = input.value.slice(0, offset);
      const marker = document.createElement("span"); marker.textContent = "\u200b"; mirror.append(marker);
      document.body.append(mirror);
      input.scrollTop = Math.max(0, marker.offsetTop - parseFloat(style.paddingTop));
      mirror.remove();
    }
  }

  function sync() { if (!scheduled) scheduled = requestAnimationFrame(resize); }
  function setExpanded(value: boolean) {
    if (expanded !== value) manualHeight = undefined;
    expanded = value;
    paintToggle();
    sync();
  }
  input.addEventListener("focus", () => setExpanded(true));
  input.addEventListener("input", sync);
  designMenu?.addEventListener("toggle", sync);
  input.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.isComposing || !expanded) return;
    event.preventDefault(); event.stopPropagation();
    setExpanded(false); toggle.focus({ preventScroll: true });
  });
  toggle.addEventListener("click", () => {
    const value = !expanded;
    setExpanded(value);
    if (value) input.focus({ preventScroll: true });
  });
  // Blur deliberately keeps the editor open, so nearby buttons cannot move before click.
  const inputSize = new ResizeObserver(() => {
    const height = input.getBoundingClientRect().height;
    if (expanded && appliedHeight && Math.abs(height - appliedHeight) > 1) {
      manualHeight = height; appliedHeight = height;
    }
  });
  inputSize.observe(input);
  const chrome = new ResizeObserver(sync);
  for (const node of composer.children) if (node !== input.closest("form")) chrome.observe(node);
  const top = document.querySelector(".top"); if (top) chrome.observe(top);
  window.addEventListener("resize", sync);
  window.visualViewport?.addEventListener("resize", sync);
  onLocale(() => { paintToggle(); sync(); });
  sync();
  return {
    sync,
    reveal(offset: number) {
      setExpanded(true);
      input.focus({ preventScroll: true });
      input.setSelectionRange(offset, offset);
      revealAt = offset;
      sync();
    },
  };
}
