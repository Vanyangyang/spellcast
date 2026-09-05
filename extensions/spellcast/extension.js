const vscode = require("vscode");

function bridgeUrl() {
  const raw = vscode.workspace.getConfiguration("spellcast").get("bridgeUrl");
  return String(raw || "http://127.0.0.1:47194").replace(/\/$/, "");
}

async function health() {
  try {
    const res = await fetch(`${bridgeUrl()}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function panelHtml(webview, state) {
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-inline'`,
  ].join("; ");
  const live = state && state.ok;
  const status = !live
    ? "Spellcast 桌面程序没在跑。先启动它（仓库里 npm run desktop，或装好的 Spellcast）。"
    : "Spellcast 桌面程序正在运行。";
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <style>
      html, body { margin: 0; height: 100%; background: #07080c; color: #f4f1ea; font: 14px/1.55 "IBM Plex Sans", "Noto Sans SC", sans-serif; }
      main { padding: 18px 16px; display: grid; gap: 10px; }
      em { font-family: Georgia, serif; font-size: 26px; font-style: italic; }
      p { margin: 0; color: rgba(244,241,234,0.62); }
      .status { display: flex; gap: 8px; align-items: center; color: #f4f1ea; }
      .dot { width: 8px; height: 8px; border-radius: 999px; background: ${live ? "#7ee0c8" : "rgba(244,241,234,0.25)"}; }
      button { display: block; width: 100%; margin: 0; border: 0; border-radius: 999px; padding: 10px 14px; font: 500 13px sans-serif; cursor: pointer; }
      .primary { background: #f4f1ea; color: #111; }
      .ghost { background: transparent; color: #f4f1ea; border: 1px solid rgba(244,241,234,0.16); }
    </style>
  </head>
  <body>
    <main>
      <em>Spellcast</em>
      <p>在 Cursor 旁打开 Spellcast 的桌面与头脑风暴板。这个扩展不会修改 Cursor 或其他 Agent 的配置。</p>
      <div class="status"><span class="dot"></span><span>${status}</span></div>
      <button class="primary" id="board">打开 Spellcast 的板</button>
      <button class="ghost" id="refresh">刷新状态</button>
    </main>
    <script>
      const vscode = acquireVsCodeApi();
      document.getElementById("board").onclick = () => vscode.postMessage({ type: "spellcast.board" });
      document.getElementById("refresh").onclick = () => vscode.postMessage({ type: "spellcast.refresh" });
    </script>
  </body>
</html>`;
}

async function openBoard() {
  const state = await health();
  if (!state) {
    vscode.window.showWarningMessage("Spellcast 桌面程序没在跑。先启动它，再打开板。");
    return;
  }
  try {
    await fetch(`${bridgeUrl()}/api/focus`, { method: "POST", signal: AbortSignal.timeout(1200) });
  } catch {
    vscode.window.showWarningMessage("Spellcast 没有响应。");
  }
}

function activate(context) {
  let view = null;
  const refresh = async () => {
    if (!view) return;
    view.webview.html = panelHtml(view.webview, await health());
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("spellcast.environment", {
      resolveWebviewView(webviewView) {
        view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        void refresh();
        context.subscriptions.push(
          webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === "spellcast.board") vscode.commands.executeCommand("spellcast.board");
            if (msg?.type === "spellcast.refresh") void refresh();
          }),
        );
        webviewView.onDidChangeVisibility(() => {
          if (webviewView.visible) void refresh();
        });
      },
    }),
  );

  context.subscriptions.push(vscode.commands.registerCommand("spellcast.board", () => void openBoard()));
  context.subscriptions.push(vscode.commands.registerCommand("spellcast.expand", () => void openBoard()));

  // Surface words entered on the board in the editor without implying an agent connection.
  let lastSeq = -1;
  const poll = async () => {
    try {
      const res = await fetch(`${bridgeUrl()}/api/events?since=${Math.max(0, lastSeq)}`, {
        signal: AbortSignal.timeout(1200),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (lastSeq < 0) {
        lastSeq = data.last_seq || 0;
        return;
      }
      for (const e of data.events || []) {
        if (e.kind === "say" || e.kind === "reply") {
          const text = String(e.text || "").trim();
          if (!text) continue;
          vscode.window
            .showInformationMessage(`Spellcast：「${text}」`, "复制到剪贴板")
            .then((pick) => {
              if (pick) void vscode.env.clipboard.writeText(text);
            });
        }
      }
      lastSeq = data.last_seq || lastSeq;
    } catch {
      lastSeq = -1;
    }
  };
  const timer = setInterval(() => void poll(), 3000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {}

module.exports = { activate, deactivate };
