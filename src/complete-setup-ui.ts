import type { SetupKind, SetupReport } from "./types";
import type { MessageKey } from "./i18n";

export const SETUP_KIND_MESSAGE: Record<SetupKind, MessageKey> = {
  unsupported: "setup.status.unsupported",
  missing_cli: "setup.status.missingCli",
  missing_resources: "setup.status.missingResources",
  not_installed: "setup.status.notInstalled",
  installing: "setup.status.installing",
  installed_pending_trust: "setup.status.pendingTrust",
  installed_unverified: "setup.status.installedUnverified",
  pending_reload: "setup.status.pendingReload",
  verified: "setup.status.verified",
  conflict_custom: "setup.status.conflictCustom",
  conflict_endpoint: "setup.status.conflictEndpoint",
  failed: "setup.status.failed",
};

export const SETUP_KIND_HINT: Record<SetupKind, MessageKey> = {
  unsupported: "setup.hint.unsupported",
  missing_cli: "setup.hint.missingCli",
  missing_resources: "setup.hint.missingResources",
  not_installed: "setup.hint.notInstalled",
  installing: "setup.hint.installing",
  installed_pending_trust: "setup.hint.pendingTrust",
  installed_unverified: "setup.hint.installedUnverified",
  pending_reload: "setup.hint.pendingReload",
  verified: "setup.hint.verified",
  conflict_custom: "setup.hint.conflictCustom",
  conflict_endpoint: "setup.hint.conflictEndpoint",
  failed: "setup.hint.failed",
};

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type SetupToken = {
  generation: number;
  client: string;
  url: string;
  op: "preview" | "install";
};

export type SetupSession = {
  generation: number;
  inflight: boolean;
  lockedClient: string | null;
  lockedUrl: string | null;
};

export function createSetupSession(): {
  state(): SetupSession;
  beginPreview(client: string, url: string): SetupToken | null;
  beginInstall(client: string, url: string): SetupToken | null;
  endInstall(): void;
  canApplyPreview(token: SetupToken, client: string, url: string): boolean;
  canApplyInstall(token: SetupToken): boolean;
} {
  const session: SetupSession = {
    generation: 0,
    inflight: false,
    lockedClient: null,
    lockedUrl: null,
  };
  return {
    state: () => ({ ...session }),
    beginPreview(client, url) {
      if (session.inflight) return null;
      session.generation += 1;
      return { generation: session.generation, client, url, op: "preview" };
    },
    beginInstall(client, url) {
      if (session.inflight) return null;
      session.inflight = true;
      session.lockedClient = client;
      session.lockedUrl = url;
      session.generation += 1;
      return { generation: session.generation, client, url, op: "install" };
    },
    endInstall() {
      session.inflight = false;
      session.lockedClient = null;
      session.lockedUrl = null;
    },
    canApplyPreview(token, client, url) {
      if (token.op !== "preview") return false;
      if (session.inflight) return false;
      return token.generation === session.generation && token.client === client && token.url === url;
    },
    canApplyInstall(token) {
      if (token.op !== "install") return false;
      return token.generation === session.generation && session.inflight;
    },
  };
}

export function reportDetailLines(report: SetupReport): { source?: string; cache?: string; marketplace?: string } {
  return {
    source: report.source_path || undefined,
    cache: report.cache_path || undefined,
    marketplace: report.marketplace_path || undefined,
  };
}

export function statusReadFailedReport(client: string, message: string): SetupReport {
  return {
    client,
    kind: "failed",
    complete_supported: client === "codex",
    installed: false,
    note: "",
    done: [],
    not_done: [message],
    conflicts: [],
    source_path: null,
    cache_path: null,
    marketplace_path: null,
    backup: null,
    mcp_url: null,
    ui: "status-read-failed",
  };
}

export function installingReport(client: string): SetupReport {
  return {
    client,
    kind: "installing",
    complete_supported: true,
    installed: false,
    note: "",
    done: [],
    not_done: [],
    conflicts: [],
    source_path: null,
    cache_path: null,
    marketplace_path: null,
  };
}

function mainHintKey(report: SetupReport): MessageKey {
  if (report.ui === "status-read-failed") return "setup.hint.readFailed";
  if (report.client === "grok") {
    if (report.kind === "verified") return "setup.hint.grokVerified";
    if (report.kind === "not_installed") {
      return report.mcp_url ? "setup.hint.grokNotInstalled" : "setup.hint.desktopPreview";
    }
  }
  if (report.hook_trust === "modified") return "setup.hint.modified";
  if (report.hook_trust === "disabled") return "setup.hint.disabled";
  if (report.kind === "not_installed" && report.complete_supported && !report.source_path && !report.mcp_url) {
    return "setup.hint.desktopPreview";
  }
  return SETUP_KIND_HINT[report.kind] ?? "setup.hint.failed";
}

function setText(id: string, text: string) {
  const el = document.querySelector<HTMLElement>(id);
  if (el) el.textContent = text;
}

export function paintSetupView(report: SetupReport, t: Translate) {
  const grok = report.client === "grok";
  const status = grok && report.kind === "verified"
    ? t("setup.status.grokVerified")
    : t(report.hook_trust === "disabled" ? "setup.status.hooksDisabled"
    : report.hook_trust === "modified" ? "setup.status.hooksModified"
    : SETUP_KIND_MESSAGE[report.kind] ?? "setup.status.unverified");
  const hint = t(mainHintKey(report));
  setText("#agent-setup-status", status);
  setText("#settings-setup-status", status);
  setText("#agent-setup-hint", hint);
  setText("#settings-setup-hint", hint);
  document.querySelectorAll<HTMLElement>("[data-setup-title]").forEach((el) => {
    el.textContent = t(grok ? "setup.titleGrok" : "setup.title");
  });
  document.querySelectorAll<HTMLElement>("[data-setup-body]").forEach((el) => {
    el.textContent = t("settings.body");
  });
  document.querySelectorAll<HTMLElement>("[data-setup-hooks-desc]").forEach((el) => {
    el.textContent = t("setup.hooksDescription");
  });
  document.querySelectorAll<HTMLElement>("[data-setup-skill-desc]").forEach((el) => {
    el.textContent = t("setup.skillDescription");
  });
  document.querySelectorAll<HTMLElement>("[data-setup-mcp-desc]").forEach((el) => {
    el.textContent = t(grok ? "setup.mcpDescriptionGrok" : "setup.mcpDescription");
  });
  document.querySelectorAll<HTMLButtonElement>("#agent-complete-setup, #settings-complete-setup").forEach(button => {
    button.textContent = t(report.kind === "installing" ? "setup.installing"
      : grok ? (report.installed ? "setup.updateGrok" : "setup.installGrok")
      : report.installed ? "setup.update"
      : "setup.install");
  });
  document.querySelectorAll<HTMLButtonElement>("[data-setup-refresh]").forEach(button => {
    button.disabled = report.kind === "installing"; button.textContent = t("setup.check");
  });
  document.querySelectorAll<HTMLElement>("[data-setup-component]").forEach(element => {
    let key: MessageKey = report.installed ? "setup.component.installed" : report.kind === "not_installed" ? "setup.component.missing" : "setup.component.unknown";
    let tone = report.installed ? "done" : "quiet";
    if (element.dataset.setupComponent === "hooks" && grok) {
      key = "setup.component.unknown";
      tone = "quiet";
    } else if (element.dataset.setupComponent === "hooks" && report.installed) {
      const trust = report.hook_trust || "unknown";
      key = `setup.hooks.${trust}` as MessageKey;
      tone = trust === "trusted" ? "done" : trust === "unknown" ? "quiet" : "attention";
    }
    element.textContent = t(key); element.dataset.tone = tone;
  });
  document.querySelectorAll<HTMLElement>(".setup-summary").forEach(element => {
    element.dataset.tone = report.kind === "verified" ? "done" : "quiet";
  });
  const paths = reportDetailLines(report);
  const details = [
    report.note,
    ...report.done,
    ...report.not_done,
    ...report.conflicts,
    paths.source ? t("setup.source", { path: paths.source }) : "",
    paths.cache ? t("setup.cache", { path: paths.cache }) : "",
    paths.marketplace ? t("setup.marketplace", { path: paths.marketplace }) : "",
  ].filter((line) => line && line !== hint && line !== status);
  const body = [...new Set(details)].join("\n");
  setText("#agent-setup-details-body", body);
  setText("#settings-setup-details-body", body);
  document.querySelectorAll<HTMLElement>(".setup-details").forEach((el) => {
    el.hidden = !body;
  });
}

export function createSetupController(opts: {
  t: Translate;
  status: (client: string, url: string) => Promise<SetupReport>;
  install: (client: string, url: string) => Promise<SetupReport>;
  getClient: () => string;
  getUrl: () => string;
  setLocked?: (locked: boolean) => void;
}) {
  const session = createSetupSession();
  let last: SetupReport | null = null;
  const paint = (report: SetupReport) => {
    last = report;
    paintSetupView(report, opts.t);
  };
  return {
    session,
    lastReport: () => last,
    paint,
    async preview(client: string, url: string) {
      if (session.state().inflight) return;
      const token = session.beginPreview(client, url);
      if (!token) return;
      const checking = (on: boolean) => document.querySelectorAll<HTMLButtonElement>("[data-setup-refresh]").forEach(button => {
        button.disabled = on; button.textContent = opts.t(on ? "setup.checking" : "setup.check");
      });
      checking(true);
      try {
        const report = await opts.status(client, url);
        if (!session.canApplyPreview(token, opts.getClient(), opts.getUrl())) return;
        paint(report);
      } catch (error) {
        if (!session.canApplyPreview(token, opts.getClient(), opts.getUrl())) return;
        const message = error instanceof Error ? error.message : String(error);
        paint(statusReadFailedReport(client, message));
      } finally {
        if (token.generation === session.state().generation) checking(false);
      }
    },
    async install(client: string, url: string) {
      const token = session.beginInstall(client, url);
      if (!token) return;
      opts.setLocked?.(true);
      paint(installingReport(client));
      try {
        const report = await opts.install(token.client, token.url);
        if (!session.canApplyInstall(token)) return;
        paint(report);
      } catch (error) {
        if (!session.canApplyInstall(token)) return;
        const message = error instanceof Error ? error.message : String(error);
        paint({
          client: token.client,
          kind: "failed",
          complete_supported: true,
          installed: false,
          note: message,
          done: [],
          not_done: [],
          conflicts: [],
          source_path: null,
          cache_path: null,
          marketplace_path: null,
        });
      } finally {
        if (token.generation === session.state().generation) {
          session.endInstall();
          opts.setLocked?.(false);
        }
      }
    },
  };
}
