import { applyBubbleEl } from "./bubble-view";
import { viewportOnCurrentScreen } from "./screens";
import type { ThrownBubble } from "./types";

type Handlers = {
  onPoke: (item: ThrownBubble) => void;
};

export function createAmbient(root: HTMLElement, handlers: Handlers) {
  const throwOne = (item: ThrownBubble) => {
    if (!root.isConnected) return;
    const rect = viewportOnCurrentScreen();
    const life = Math.max(8000, item.linger_ms || 16000);
    const left = rect.left + (0.18 + Math.random() * 0.64) * rect.width;
    const drift = (Math.random() - 0.5) * Math.min(72, rect.width * 0.16);
    const rise = Math.max(220, rect.height * 0.62);
    const el = document.createElement("button");
    el.type = "button";
    applyBubbleEl(el, item);
    // Start mid-screen so the bubble is visible immediately, not under the dock.
    el.style.left = `${left}px`;
    el.style.bottom = `${Math.max(140, rect.height * 0.32)}px`;
    el.style.setProperty("--drift", `${drift}px`);
    el.style.setProperty("--rise", `${rise}px`);
    el.style.setProperty("--life", `${life}ms`);
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-in"));

    let gone = false;
    let timer = window.setTimeout(() => die(true), life);

    function die(quietly: boolean) {
      if (gone || !el.isConnected) return;
      gone = true;
      window.clearTimeout(timer);
      el.classList.add(quietly ? "is-fade" : "is-pop");
      window.setTimeout(() => el.remove(), quietly ? 720 : 340);
    }

    const poke = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (gone) return;
      die(false);
      handlers.onPoke(item);
    };

    el.addEventListener("pointerenter", () => {
      if (gone) return;
      window.clearTimeout(timer);
      el.classList.add("is-held");
    });
    el.addEventListener("pointerleave", () => {
      if (gone) return;
      el.classList.remove("is-held");
      timer = window.setTimeout(() => die(true), 3200);
    });
    el.addEventListener("pointerdown", poke);
    el.addEventListener("click", poke);
  };

  return {
    throwAll(items: ThrownBubble[]) {
      items.slice(0, 3).forEach((item) => {
        window.setTimeout(() => throwOne(item), item.delay_ms || 0);
      });
    },
    clear() {
      root.replaceChildren();
    },
    living() {
      return root.querySelectorAll(".bubble").length;
    },
  };
}
