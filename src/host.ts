import "./host.css";
import type { EnvToHost } from "./protocol";
import { isEnvToHost } from "./protocol";

const frame = document.querySelector<HTMLIFrameElement>("#orbit")!;
const selection = document.querySelector<HTMLTextAreaElement>("#selection")!;
const events = document.querySelector<HTMLOListElement>("#events")!;

function send(msg: unknown) {
  frame.contentWindow?.postMessage(msg, "*");
}

document.querySelector("#send-sel")!.addEventListener("click", () => {
  const text = selection.value.trim();
  if (!text) return;
  send({ type: "orbit.utter", text });
  note("host", "utter → 环境");
});

document.querySelector("#import-sel")!.addEventListener("click", () => {
  const transcript = selection.value.trim();
  if (!transcript) return;
  send({ type: "orbit.import", transcript });
  note("host", "import → 环境");
});

document.querySelector("#reset-env")!.addEventListener("click", () => {
  send({ type: "orbit.reset" });
  note("host", "reset → 环境");
});

window.addEventListener("message", (event) => {
  if (!isEnvToHost(event.data)) return;
  const msg = event.data as EnvToHost;
  if (msg.type === "orbit.ready") {
    note("env", `就绪 v${msg.version}`);
    send({ type: "orbit.hello" });
  } else if (msg.type === "orbit.uttered") {
    note("env", `${msg.form} · 新交 ${msg.added} 粒 · ${msg.reply}`);
  } else if (msg.type === "orbit.board") {
    note("env", `板上 ${msg.board.nodes.length} 粒 · ${msg.board.form}`);
  } else if (msg.type === "orbit.select") {
    note("env", msg.node ? `点中「${msg.node.title}」` : "取消点选");
  } else if (msg.type === "orbit.error") {
    note("env", msg.message);
  }
});

function note(who: string, text: string) {
  const li = document.createElement("li");
  li.className = who;
  li.textContent = text;
  events.prepend(li);
  while (events.children.length > 8) events.lastElementChild?.remove();
}
