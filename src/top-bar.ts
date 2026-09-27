/** Publish the top bar's real height so panels below it never cover its controls when it wraps. */
const bar = document.querySelector<HTMLElement>(".top");
if (bar && "ResizeObserver" in window) {
  new ResizeObserver(() => {
    document.body.style.setProperty("--top-bar-height", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
  }).observe(bar);
}
