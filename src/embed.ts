import { isHostToEnv, ORBIT_VERSION, type EnvToHost, type HostToEnv } from "./protocol";
import type { BoardNode, BoardSnapshot, StageForm } from "./types";

type VsCodeApi = { postMessage: (msg: unknown) => void };

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

export type EnvironmentHandlers = {
  utter: (text: string, focus?: string) => Promise<void>;
  importTranscript: (transcript: string) => Promise<void>;
  setForm: (form: StageForm) => Promise<void>;
  reset: () => Promise<void>;
  getBoard: () => BoardSnapshot;
};

let vscode: VsCodeApi | null = null;
try {
  vscode = window.acquireVsCodeApi?.() ?? null;
} catch {
  vscode = null;
}

const framed = (() => {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
})();

export const embedded =
  new URLSearchParams(location.search).has("embed") || framed || Boolean(vscode);

export function connectEnvironment(handlers: EnvironmentHandlers) {
  if (embedded) document.body.classList.add("embed");

  const onMessage = async (event: MessageEvent) => {
    const data = event.data as HostToEnv;
    if (!isHostToEnv(data)) return;
    try {
      if (data.type === "orbit.hello") {
        post({ type: "orbit.ready", version: ORBIT_VERSION, embed: embedded });
        post({ type: "orbit.board", board: handlers.getBoard() });
        return;
      }
      if (data.type === "orbit.utter") {
        await handlers.utter(data.text, data.focus);
        return;
      }
      if (data.type === "orbit.import") {
        await handlers.importTranscript(data.transcript);
        return;
      }
      if (data.type === "orbit.setForm") {
        await handlers.setForm(data.form);
        return;
      }
      if (data.type === "orbit.reset") {
        await handlers.reset();
      }
    } catch (err) {
      post({
        type: "orbit.error",
        message: err instanceof Error ? err.message : "环境没接住。",
      });
    }
  };

  window.addEventListener("message", onMessage);
  post({ type: "orbit.ready", version: ORBIT_VERSION, embed: embedded });
}

export function publishBoard(board: BoardSnapshot) {
  post({ type: "orbit.board", board });
}

export function publishUttered(reply: string, form: StageForm, added: number) {
  post({ type: "orbit.uttered", reply, form, added });
}

export function publishSelect(node: BoardNode | null) {
  post({ type: "orbit.select", node });
}

function post(msg: EnvToHost) {
  vscode?.postMessage(msg);
  if (framed) {
    try {
      window.parent.postMessage(msg, "*");
    } catch {
      /* ignore */
    }
  }
}
