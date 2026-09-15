import "./completions.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Completion = {
  thread_id: string;
  turn_id: string;
  title: string;
  summary: string;
  project: string;
  completed_at_ms: number;
};
const root = document.querySelector<HTMLElement>("#completions")!;
const cards = new Map<string, HTMLElement>();
type VoiceSettings = { enabled: boolean; supported: boolean; volume: number; cooldown_seconds: number; quiet_hours: string };
const voiceButton = document.querySelector<HTMLButtonElement>("#completion-voice")!;
let voice: VoiceSettings | undefined;
function paintVoice(settings: VoiceSettings) {
  voice = settings;
  voiceButton.disabled = !settings.supported;
  voiceButton.setAttribute("aria-pressed", String(settings.enabled && settings.supported));
  voiceButton.textContent = settings.enabled && settings.supported ? "轻声提醒 · 开" : "轻声提醒 · 关";
  voiceButton.title = settings.supported
    ? `音量 ${settings.volume}%；${settings.cooldown_seconds} 秒内最多一次；${settings.quiet_hours} 静音。点击${settings.enabled ? "关闭" : "开启"}。`
    : "当前系统暂不支持离线语音提醒。";
}
voiceButton.addEventListener("click", async () => {
  if (!voice || voiceButton.disabled) return;
  voiceButton.disabled = true;
  try { paintVoice(await invoke<VoiceSettings>("set_completion_voice", { enabled: !voice.enabled })); }
  catch { voiceButton.disabled = false; voiceButton.title = "语音设置未能保存，请重试。"; }
});

function render(items: Completion[]) {
  const active = new Set(items.map(item => item.thread_id));
  for (const [id, card] of cards) if (!active.has(id)) { card.remove(); cards.delete(id); }
  items.forEach((item, index) => {
    let card = cards.get(item.thread_id);
    if (!card || card.dataset.turn !== item.turn_id) {
      card?.remove();
      card = document.createElement("article");
      card.className = "completion-bubble";
      card.dataset.thread = item.thread_id;
      card.dataset.turn = item.turn_id;
      card.innerHTML = `<button class="task" type="button"><span class="status"><span class="check" aria-hidden="true">✓</span>任务已完成<span class="project"></span></span><strong class="title"></strong><span class="summary"></span><span class="hint">双击回到 Codex ↗</span></button><button class="dismiss" type="button" aria-label="移除这条完成气泡" title="移除气泡">×</button><span class="error" role="status"></span>`;
      const button = card.querySelector<HTMLButtonElement>(".task")!;
      const error = card.querySelector<HTMLElement>(".error")!;
      let opening = false;
      const open = async () => {
        if (opening) return;
        opening = true; error.textContent = "";
        const hint = card!.querySelector<HTMLElement>(".hint")!;
        hint.textContent = "正在打开 Codex…";
        try {
          await invoke("open_completed_task", { threadId: item.thread_id, turnId: item.turn_id });
          card?.classList.add("dismissing");
          hint.textContent = "已打开 Codex";
        }
        catch (reason) { error.textContent = String(reason); hint.textContent = "双击回到 Codex ↗"; }
        finally { opening = false; }
      };
      button.addEventListener("dblclick", () => void open());
      button.addEventListener("click", event => { if (event.detail === 0) void open(); });
      card.querySelector(".dismiss")!.addEventListener("click", async () => {
        try {
          await invoke("dismiss_completion", { threadId: item.thread_id, turnId: item.turn_id });
          // The authoritative snapshot removes it; a newer turn remains available.
          card?.classList.add("dismissing");
        } catch { error.textContent = "气泡未能移除，请重试。"; }
      });
      cards.set(item.thread_id, card);
    }
    const title = item.title.trim();
    const meaningfulTitle = title && !/^codex\s*(任务|task)$/i.test(title);
    const titleEl = card.querySelector<HTMLElement>(".title")!;
    titleEl.textContent = meaningfulTitle ? title : "";
    titleEl.hidden = !meaningfulTitle;
    card.querySelector(".summary")!.textContent = item.summary;
    card.querySelector(".project")!.textContent = item.project;
    card.querySelector(".task")!.setAttribute("aria-label", `${meaningfulTitle ? title : item.project || "Codex"}，任务已完成，双击或按回车回到 Codex`);
    // Retain the live node during updates so an arriving task cannot interrupt a double-click.
    if (root.children[index] !== card) root.insertBefore(card, root.children[index] ?? null);
  });
}

async function boot() {
  await listen<VoiceSettings>("spellcast-completion-voice", event => paintVoice(event.payload));
  await listen<Completion[]>("spellcast-completions", event => render(event.payload));
  const [items, settings] = await Promise.all([invoke<Completion[]>("get_completions"), invoke<VoiceSettings>("get_completion_voice")]);
  render(items); paintVoice(settings);
}
void boot().catch(() => { root.textContent = "完成通知暂时不可用，请重新打开 Spellcast。"; });
