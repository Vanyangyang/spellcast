export const flowEl = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") => {
  const element = document.createElement(tag); element.textContent = text; element.className = cls; return element;
};
export function flowButton(text: string, key: string, action: () => void) {
  const button = flowEl("button", text); button.type = "button"; button.dataset.flowAction = key; button.addEventListener("click", action); return button;
}
export function flowField(text: string, value: string, key: string, change: (value: string) => void, multiline = false) {
  const label = flowEl("label"), input = multiline ? flowEl("textarea") : flowEl("input");
  input.value = value; input.dataset.flowField = key; if (input instanceof HTMLTextAreaElement) input.rows = 3;
  input.addEventListener("input", () => change(input.value)); label.append(flowEl("span", text), input); return label;
}
export function flowSelect(text: string, value: string, key: string, values: Array<[string, string]>, change: (value: string) => void) {
  const label = flowEl("label"), select = flowEl("select"); select.dataset.flowField = key;
  for (const [id, title] of values) { const option = flowEl("option", title); option.value = id; select.append(option); }
  select.value = value; select.addEventListener("change", () => change(select.value)); label.append(flowEl("span", text), select); return label;
}
export function flowCheck(text: string, value: boolean, key: string, change: (value: boolean) => void) {
  const label = flowEl("label", "", "flow-check"), input = flowEl("input"); input.type = "checkbox"; input.checked = value; input.dataset.flowField = key;
  input.addEventListener("change", () => change(input.checked)); label.append(input, flowEl("span", text)); return label;
}
/** Cancels pending dynamic imports as well as mounted component resources. */
export function flowMount(host: HTMLElement, factory: () => Promise<() => void>) {
  let disposed = false, cleanup: (() => void) | undefined;
  void factory().then(value => { if (disposed) value(); else cleanup = value; }).catch(error => { if (!disposed) host.append(flowEl("p", `组件加载失败：${String(error)}`, "flow-error")); });
  return () => { disposed = true; cleanup?.(); };
}
