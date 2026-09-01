const vscode = require("vscode");

/** @type {Set<vscode.Webview>} */
const boards = new Set();

function environmentUrl() {
  const raw = vscode.workspace.getConfiguration("orbit").get("environmentUrl");
  return String(raw || "http://127.0.0.1:47193").replace(/\/$/, "");
}

function boardHtml(webview, url, mode) {
  const src = mode === "full" ? `${url}/?mode=focus` : `${url}/?embed=1`;
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-inline'`,
    `frame-src ${url} http://127.0.0.1:* http://localhost:*`,
  ].join("; ");
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <style>
      html, body, iframe { margin: 0; height: 100%; width: 100%; background: #07080c; }
      iframe { border: 0; display: block; }
    </style>
  </head>
  <body>
    <iframe id="orbit" src="${src}" title="Spellcast 专注板"></iframe>
    <script>
      const vscode = acquireVsCodeApi();
      const frame = document.getElementById("orbit");
      window.addEventListener("message", (event) => {
        if (event.source === frame.contentWindow) {
          vscode.postMessage(event.data);
          return;
        }
        frame.contentWindow.postMessage(event.data, "*");
      });
    </script>
  </body>
</html>`;
}

function launcherHtml(webview) {
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-inline'`,
  ].join("; ");
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <style>
      html, body { margin: 0; height: 100%; background: #07080c; color: #f4f1ea; font: 14px/1.5 "IBM Plex Sans", "Noto Sans SC", sans-serif; }
      main { padding: 18px 16px; }
      em { font-family: Georgia, serif; font-size: 26px; font-style: italic; }
      p { color: rgba(244,241,234,0.62); }
      button { display: block; width: 100%; margin: 8px 0 0; border: 0; border-radius: 999px; padding: 10px 14px; font: 500 13px sans-serif; cursor: pointer; }
      .primary { background: #f4f1ea; color: #111; }
      .ghost { background: transparent; color: #f4f1ea; border: 1px solid rgba(244,241,234,0.16); }
    </style>
  </head>
  <body>
    <main>
      <em>Spellcast</em>
      <p>插件只是入口。展开之后是专注板：空间碎片，不是聊天窗。</p>
      <button class="primary" id="expand">展开专注板</button>
      <button class="ghost" id="scatter">把选区丢上板</button>
      <button class="ghost" id="window">在浏览器里打开整块板</button>
    </main>
    <script>
      const vscode = acquireVsCodeApi();
      document.getElementById("expand").onclick = () => vscode.postMessage({ type: "orbit.expand" });
      document.getElementById("scatter").onclick = () => vscode.postMessage({ type: "orbit.scatter" });
      document.getElementById("window").onclick = () => vscode.postMessage({ type: "orbit.external" });
    </script>
  </body>
</html>`;
}

function attachBoard(webview, mode) {
  webview.options = { enableScripts: true };
  webview.html = boardHtml(webview, environmentUrl(), mode);
  boards.add(webview);
  const sub = webview.onDidReceiveMessage((msg) => {
    if (msg && msg.type === "orbit.error") {
      vscode.window.showErrorMessage(String(msg.message || "板上出了问题"));
    }
  });
  return {
    dispose: () => {
      boards.delete(webview);
      sub.dispose();
    },
  };
}

function expandBoard() {
  const panel = vscode.window.createWebviewPanel(
    "orbit.board",
    "专注板",
    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true },
  );
  return attachBoard(panel.webview, "full");
}

function broadcast(msg) {
  if (!boards.size) {
    expandBoard();
  }
  setTimeout(() => {
    for (const view of boards) view.postMessage(msg);
  }, 400);
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("orbit.environment", {
      resolveWebviewView(webviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = launcherHtml(webviewView.webview);
        context.subscriptions.push(
          webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === "orbit.expand") vscode.commands.executeCommand("orbit.expand");
            if (msg?.type === "orbit.scatter") vscode.commands.executeCommand("orbit.scatter");
            if (msg?.type === "orbit.external") vscode.commands.executeCommand("orbit.openExternal");
          }),
        );
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("orbit.expand", () => {
      context.subscriptions.push(expandBoard());
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("orbit.openExternal", () => {
      vscode.env.openExternal(vscode.Uri.parse(environmentUrl() + "/"));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("orbit.scatter", () => {
      const editor = vscode.window.activeTextEditor;
      const text = editor?.document.getText(editor.selection)?.trim() || editor?.document.getText()?.trim();
      if (!text) {
        vscode.window.showWarningMessage("先选一段还没想完的话。");
        return;
      }
      broadcast({ type: "orbit.utter", text });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("orbit.importFile", () => {
      const editor = vscode.window.activeTextEditor;
      const transcript = editor?.document.getText()?.trim();
      if (!transcript) {
        vscode.window.showWarningMessage("当前没有可导入的文件。");
        return;
      }
      broadcast({ type: "orbit.import", transcript });
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
