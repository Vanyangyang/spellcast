import { currentLocale } from "./index";

const words = {
  en: {
    title: "Application delegation", description: "Allow a verified local application to save records or drafts, and optionally claim or advance running Sigils. Discovery never grants permission.",
    refresh: "Refresh applications", loading: "Reading application access…", ready: "Access status refreshed. No permission is granted by discovery.",
    unavailable: "Application delegation is unavailable in this environment. Open the Spellcast Windows desktop app.",
    storageUnprotected: "The state directory is not restricted to its OS owner. Delegation is disabled; directory permissions were not weakened or rewritten.",
    pipeUnavailable: "The local authorization pipe could not be established. No alternative connection was used.",
    loadFailed: "Could not read application access. Refresh to try again.",
    writeFailed: "The change was not confirmed. Access status was refreshed where possible. Review the current state before trying again.",
    saved: "Approval confirmed. Access status refreshed.", revokedDone: "Revocation confirmed. Access status refreshed.",
    candidates: "Discovered applications", grants: "Application grants", noCandidates: "No applications discovered.", noGrants: "No application grants.",
    path: "Canonical executable path", sha256: "SHA256", sid: "Windows SID", process: "Process ID", revision: "Revision", generation: "Generation",
    records: "Save records", sigilDrafts: "Save global Sigil drafts", sigilClaims: "Claim running Sigils", sigilRun: "Advance Sigil steps", review: "Review approval", revoke: "Revoke access",
    approved: "Approved", revoked: "Revoked", pending: "Not approved", scopeNone: "No save rights selected",
    identityChanged: "The application image changed. Native approval is required again.",
    confirmTitle: "Confirm application delegation", selected: "Selected permissions", cancel: "Cancel", confirm: "Approve selected permissions",
    recordsWarning: "Record permission applies to all present and future projects.",
    draftsWarning: "Sigil draft permission applies to all global drafts. New drafts also create their fixed new-draft Canvas card.",
    claimsWarning: "Claim permission lets the application take or request executor ownership on running Sigils.",
    runWarning: "Run permission lets the application start and report steps on claimed Sigils. It does not freeze or create worktrees.",
    devicesWarning: "This delegation also applies to all current and future approved CCGUI web devices until you revoke it.",
    exclusions: "This still does not permit freezing a draft, creating worktrees, selecting models, or using Observer. Claim/run only steer an already started Sigil.",
    confirmHint: "Verify the executable identity and the selected permissions before approving. Neither permission is selected by default.",
  },
  "zh-CN": {
    title: "应用委托", description: "允许经过验证的本地应用保存记录或全局 Sigil 草稿。发现应用不会授予权限。",
    refresh: "刷新应用", loading: "正在读取应用权限…", ready: "已刷新权限状态。发现应用不会授予任何权限。",
    unavailable: "当前环境无法使用应用委托，请打开 Spellcast Windows 桌面应用。",
    storageUnprotected: "状态目录未限定为 OS 用户所有者访问，应用委托已停用；没有放宽或重写目录权限。",
    pipeUnavailable: "无法建立本机授权管道，没有改用其他连接。",
    loadFailed: "未能读取应用权限，请刷新重试。",
    writeFailed: "未能确认变更。已尽可能刷新权限状态，请核对当前状态后重试。",
    saved: "已确认授权并刷新权限状态。", revokedDone: "已确认撤销并刷新权限状态。",
    candidates: "发现的应用", grants: "应用授权", noCandidates: "尚未发现应用。", noGrants: "尚无应用授权。",
    path: "可执行文件规范路径", sha256: "SHA256", sid: "Windows SID", process: "进程 ID", revision: "修订号", generation: "授权代次",
    records: "保存记录", sigilDrafts: "保存全局 Sigil 草稿", sigilClaims: "认领运行中的法阵", sigilRun: "推进法阵步骤", review: "查看授权确认", revoke: "撤销权限",
    approved: "已授权", revoked: "已撤销", pending: "未授权", scopeNone: "未选择保存权限",
    identityChanged: "应用映像已改变，需要重新原生确认。",
    confirmTitle: "确认应用委托", selected: "选择的权限", cancel: "取消", confirm: "授予所选权限",
    recordsWarning: "记录权限适用于所有现有及未来项目。",
    draftsWarning: "法阵草稿权限适用于所有全局草稿。每个新草稿会同时创建固定的新草稿 Canvas 引用卡片。",
    claimsWarning: "认领权限允许应用在运行中的法阵上取得或请求执行者身份。",
    runWarning: "推进权限允许应用在已认领的法阵上开始并汇报步骤；不会冻结草稿或创建 worktree。",
    devicesWarning: "此委托还适用于所有当前及未来获准的 CCGUI 网页设备，直至你撤销权限。",
    exclusions: "仍不允许冻结草稿、创建 worktree、选择模型或使用 Observer。认领/推进只对已启动的法阵生效。",
    confirmHint: "授权前请核对可执行文件身份及所选权限。两项权限默认均不勾选。",
  },
};

export type ClientAccessTextKey = keyof typeof words.en;
export function clientAccessText(key: ClientAccessTextKey): string {
  return words[currentLocale()][key];
}
