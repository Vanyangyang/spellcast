import { currentLocale } from "./index";

const en = {
  replies: "Replies", ideas: "Kept ideas", memory: "Memory", feedback: "Feedback",
  pause: "Pause bubbles", resume: "Resume bubbles", close: "Close",
  about: "About: {title}", noTarget: "Choose an idea or a reply to continue.",
  sent: "Saved — waiting for the originating task.", processed: "This feedback has been handled.",
  recipient: "Task to receive this", chooseTask: "Choose a task", savedUnassigned: "Saved without a task assigned.",
  replyPlaceholder: "Continue this idea, question a detail, or add a constraint…", continue: "Continue on the board",
  waiting: "{n} waiting", unassigned: "No task assigned", emptyFeedback: "No feedback is waiting.",
  feedbackHelp: "Replies and selections stay here until their originating task handles them. A closed task will pick them up when it runs again.",
  memoryTitle: "What you asked to remember", memoryHelp: "These memories stay on this computer. Keeping a bubble does not automatically create a memory.",
  search: "Search memories", searchPlaceholder: "A word, an idea, a decision…", recent: "Up to 20 recent matches",
  memoryName: "Short title", memoryText: "What should stay remembered?", save: "Remember this",
  forget: "Forget", noMemories: "No matching memories.", memorySaved: "Remembered on this computer.",
  memoryForgotten: "This memory has been removed.", openIdea: "Open idea", openReply: "Open reply",
  expand: "Develop this idea", expandText: "Develop this adopted idea on the board. Use the expression that fits and preserve its context.",
  boardEmpty: "Keep a thought, then give it room.", boardEmptyBody: "Adopt a desktop bubble or add an idea. Select it and ask your agent to develop it on this board.",
  received: "New reply", error: "Could not complete this action.", saving: "Saving…",
};
type Key = keyof typeof en;
const zh: Record<Key, string> = {
  replies: "板上回复", ideas: "采纳的想法", memory: "记忆", feedback: "反馈",
  pause: "暂停气泡", resume: "恢复气泡", close: "关闭",
  about: "关于：{title}", noTarget: "先选择一条想法或一块回复，再继续展开。",
  sent: "已保存，等待原任务接手。", processed: "这条反馈已被处理。",
  recipient: "接收这条输入的任务", chooseTask: "选择任务", savedUnassigned: "已保存，尚未指定接收任务。",
  replyPlaceholder: "继续这个想法，质疑一个细节，或补充一个约束…", continue: "在板上继续",
  waiting: "{n} 条待接手", unassigned: "尚未指定任务", emptyFeedback: "没有待处理的反馈。",
  feedbackHelp: "回复和选择会保留到原任务确认处理。已经结束的任务，需要再次运行后才能接手。",
  memoryTitle: "你明确要求记住的事", memoryHelp: "这些记忆留在本机。采纳气泡不会自动创建长期记忆。",
  search: "搜索记忆", searchPlaceholder: "一个词、想法或决定…", recent: "最多显示 20 条最近的匹配结果",
  memoryName: "简短标题", memoryText: "什么内容应该留在记忆里？", save: "记住这件事",
  forget: "忘记", noMemories: "没有匹配的记忆。", memorySaved: "已在本机记住。",
  memoryForgotten: "这条记忆已移除。", openIdea: "回到想法", openReply: "回到回复",
  expand: "展开这个想法", expandText: "请在板上展开这个采纳的想法。选择适合它的表达形式，并保留上下文。",
  boardEmpty: "留下一个念头，再给它一点空间。", boardEmptyBody: "采纳桌面气泡，或自己放下一个想法。选中它，请 Agent 在这块板上继续展开。",
  received: "有新回复", error: "这次操作没有完成。", saving: "正在保存…",
};
const ja: Record<Key, string> = {
  replies: "ボードの返信", ideas: "採用したアイデア", memory: "記憶", feedback: "フィードバック",
  pause: "バブルを一時停止", resume: "バブルを再開", close: "閉じる",
  about: "対象：{title}", noTarget: "アイデアか返信を選んでから続けてください。",
  sent: "保存しました。元のタスクでの処理を待っています。", processed: "このフィードバックは処理済みです。",
  recipient: "入力を受け取るタスク", chooseTask: "タスクを選択", savedUnassigned: "タスク未指定で保存しました。",
  replyPlaceholder: "アイデアを続ける、詳細を問い直す、条件を加える…", continue: "ボードで続ける",
  waiting: "{n} 件の処理待ち", unassigned: "タスク未指定", emptyFeedback: "処理待ちのフィードバックはありません。",
  feedbackHelp: "返信や選択は元のタスクが処理するまで保持されます。終了したタスクは再開後に受け取れます。",
  memoryTitle: "明示的に記憶を依頼したこと", memoryHelp: "記憶はこのコンピューターに保存されます。バブルの採用だけでは長期記憶になりません。",
  search: "記憶を検索", searchPlaceholder: "言葉、アイデア、決定…", recent: "最近の一致を最大 20 件表示",
  memoryName: "短いタイトル", memoryText: "何を記憶に残しますか？", save: "これを記憶する",
  forget: "忘れる", noMemories: "一致する記憶はありません。", memorySaved: "このコンピューターに記憶しました。",
  memoryForgotten: "この記憶を削除しました。", openIdea: "アイデアを開く", openReply: "返信を開く",
  expand: "このアイデアを展開", expandText: "採用したアイデアをボードで展開してください。適切な表現を選び、文脈を保ってください。",
  boardEmpty: "ひとつの思いつきに、広がる場所を。", boardEmptyBody: "バブルを採用するか、アイデアを追加します。選択して Agent に展開を依頼できます。",
  received: "新しい返信", error: "操作を完了できませんでした。", saving: "保存中…",
};

export function bt(key: Key, vars: Record<string, string | number> = {}): string {
  const locale = currentLocale();
  let text = (locale === "zh-CN" ? zh : locale === "ja" ? ja : en)[key];
  for (const [name, value] of Object.entries(vars)) text = text.replaceAll("{" + name + "}", String(value));
  return text;
}
