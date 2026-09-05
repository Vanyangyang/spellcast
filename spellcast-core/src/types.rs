use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Idea,
    Question,
    Risk,
    Action,
    Insight,
}

impl NodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idea => "idea",
            Self::Question => "question",
            Self::Risk => "risk",
            Self::Action => "action",
            Self::Insight => "insight",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "question" | "问题" | "问" => Self::Question,
            "risk" | "风险" | "坑" => Self::Risk,
            "action" | "行动" | "下一步" => Self::Action,
            "insight" | "洞察" | "结论" => Self::Insight,
            _ => Self::Idea,
        }
    }
}

/// How formed a fragment is. Sparks are the half-sentences everyday chatbots swallow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FragmentWeight {
    Spark,
    #[default]
    Note,
    Anchor,
}

impl FragmentWeight {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spark => "spark",
            Self::Note => "note",
            Self::Anchor => "anchor",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "spark" | "碎" | "火花" => Self::Spark,
            "anchor" | "锚" | "主张" => Self::Anchor,
            _ => Self::Note,
        }
    }
}

/// A stage the model may choose. Three.js spatial is only one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum StageForm {
    #[default]
    Constellation,
    Spatial,
    Timeline,
    Stack,
}

impl StageForm {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Constellation => "constellation",
            Self::Spatial => "spatial",
            Self::Timeline => "timeline",
            Self::Stack => "stack",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Constellation => "星散",
            Self::Spatial => "立体",
            Self::Timeline => "时序",
            Self::Stack => "并置",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "spatial" | "3d" | "three" | "立体" => Self::Spatial,
            "timeline" | "time" | "时序" | "时间线" => Self::Timeline,
            "stack" | "compare" | "并置" | "对比" => Self::Stack,
            _ => Self::Constellation,
        }
    }

    pub fn infer(text: &str) -> Self {
        let t = text.to_ascii_lowercase();
        if contains_any(
            text,
            &[
                "步骤", "流程", "然后", "先", "再", "之后", "发布", "排期", "故事", "剧情",
            ],
        ) || t.contains("timeline")
            || t.contains("roadmap")
        {
            Self::Timeline
        } else if contains_any(
            text,
            &["对比", "还是", "或者", "方案 a", "方案b", "哪个更好"],
        ) || t.contains(" vs ")
            || t.contains("option")
        {
            Self::Stack
        } else if contains_any(
            text,
            &["系统", "架构", "关系", "空间", "世界", "结构", "地图"],
        ) || t.contains("system")
            || t.contains("graph")
        {
            Self::Spatial
        } else {
            Self::Constellation
        }
    }

    pub fn reason(self) -> &'static str {
        match self {
            Self::Constellation => "这些还是碎点子，先摊开，不急着长成结构。",
            Self::Spatial => "点子之间有关系，用空间比用段落更清楚。",
            Self::Timeline => "这里有先后和因果，用一条能走的路径说。",
            Self::Stack => "几个方向要并着看，而不是写成一篇取舍作文。",
        }
    }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| text.contains(n))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardNode {
    pub id: String,
    #[serde(default)]
    pub source_id: Option<String>,
    pub title: String,
    pub body: String,
    pub kind: NodeKind,
    pub weight: FragmentWeight,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardEdge {
    pub id: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormInfo {
    pub id: String,
    pub label: String,
    pub blurb: String,
}

/// How large a desktop bubble should be. The agent chooses; the client does not infer from the whole reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BubbleSize {
    Whisper,
    #[default]
    Note,
    Flare,
}

impl BubbleSize {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Whisper => "whisper",
            Self::Note => "note",
            Self::Flare => "flare",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "whisper" | "tiny" | "词" => Self::Whisper,
            "flare" | "large" | "大" => Self::Flare,
            _ => Self::Note,
        }
    }

    pub fn linger_secs(self) -> u32 {
        match self {
            Self::Whisper => 14,
            Self::Note => 18,
            Self::Flare => 22,
        }
    }
}

/// The silhouette of a desktop bubble. The agent picks one to match what it is saying;
/// `Auto` lets the core pick from the content. Whatever the shape, it grows to fit the words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BubbleShape {
    #[default]
    Auto,
    /// A round drop. One or two words.
    Orb,
    /// A capsule. A single line.
    Pill,
    /// A rounded card. Title, a line, maybe a body.
    Card,
    /// A paper note with a folded corner. Ideas, scraps to keep.
    Sticky,
    /// A speech balloon with a tail. Questions aimed at the user.
    Speech,
    /// A monospace block. Paths, commands, a line of code.
    Code,
}

impl BubbleShape {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Orb => "orb",
            Self::Pill => "pill",
            Self::Card => "card",
            Self::Sticky => "sticky",
            Self::Speech => "speech",
            Self::Code => "code",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "orb" | "drop" | "round" | "球" | "圆" => Self::Orb,
            "pill" | "capsule" | "line" | "条" => Self::Pill,
            "card" | "note-card" | "卡" | "卡片" => Self::Card,
            "sticky" | "paper" | "post-it" | "便签" | "纸" => Self::Sticky,
            "speech" | "balloon" | "say" | "对话" | "话" => Self::Speech,
            "code" | "mono" | "snippet" | "代码" => Self::Code,
            _ => Self::Auto,
        }
    }

    /// Pick a silhouette from what is being said. Never returns `Auto`.
    pub fn resolve(self, tease: &str, title: &str, body: &str, kind: NodeKind) -> Self {
        if self != Self::Auto {
            return self;
        }
        let tease_len = tease.chars().count();
        let tease_t = tease.trim();
        let has_body = !body.trim().is_empty() && body.trim() != tease_t;
        // A title clipped out of the tease itself is not a real heading.
        let title_t = title.trim().trim_end_matches('…');
        let has_title = !title_t.is_empty() && !tease_t.starts_with(title_t);
        if looks_like_code(tease) || (has_body && !has_title && looks_like_code(body)) {
            return Self::Code;
        }
        if has_body || has_title {
            return match kind {
                NodeKind::Question => Self::Speech,
                NodeKind::Idea | NodeKind::Insight => Self::Sticky,
                _ => Self::Card,
            };
        }
        if tease_len <= 6 && !tease.contains(char::is_whitespace) {
            Self::Orb
        } else {
            Self::Pill
        }
    }
}

fn looks_like_code(text: &str) -> bool {
    let t = text.trim();
    if t.starts_with("```") || t.starts_with('`') && t.ends_with('`') {
        return true;
    }
    let path_like = (t.contains('/') || t.contains('\\')) && !t.contains(char::is_whitespace);
    let cmd_like = t.starts_with("$ ")
        || t.starts_with("npm ")
        || t.starts_with("cargo ")
        || t.starts_with("git ")
        || t.starts_with("pnpm ")
        || t.starts_with("npx ");
    path_like || cmd_like || t.contains("::") || t.contains("=>") || t.contains("();")
}

/// What happens when the user pokes a bubble. The agent chooses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PokeAction {
    #[default]
    Peek,
    Reply,
    Focus,
    Pin,
}

impl PokeAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Peek => "peek",
            Self::Reply => "reply",
            Self::Focus => "focus",
            Self::Pin => "pin",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "reply" | "答" => Self::Reply,
            "focus" | "专注" => Self::Focus,
            "pin" | "钉" => Self::Pin,
            _ => Self::Peek,
        }
    }
}

/// Which physical screen a bubble may appear on. One bubble, one screen. Never a bezel straddle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScreenAim {
    #[default]
    Active,
    Primary,
    Side,
}

impl ScreenAim {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Primary => "primary",
            Self::Side => "side",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "primary" | "main" | "主屏" => Self::Primary,
            "side" | "other" | "旁" | "侧" => Self::Side,
            _ => Self::Active,
        }
    }
}

/// A moment the agent chooses to interrupt the desktop. Never a dump of the whole reply.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProposedThrow {
    /// Index into this reply's `nodes`. Absent = a free-floating aside, not a fragment.
    #[serde(default)]
    pub node: Option<usize>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tease: String,
    #[serde(default)]
    pub size: Option<String>,
    /// orb | pill | card | sticky | speech | code. Absent = pick from the content.
    #[serde(default)]
    pub shape: Option<String>,
    #[serde(default)]
    pub on_poke: Option<String>,
    /// Seconds the bubble may live before it fades and quietly pops.
    #[serde(default)]
    pub linger: Option<u32>,
    #[serde(default)]
    pub kind: Option<String>,
    /// Optional stagger, milliseconds after the previous throw.
    #[serde(default)]
    pub delay: Option<u32>,
    /// active | primary | side. One bubble lives on one screen.
    #[serde(default)]
    pub screen: Option<String>,
}

/// Resolved bubble the desktop can throw. Sparse by design.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThrownBubble {
    pub id: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub node_id: Option<String>,
    pub tease: String,
    pub title: String,
    pub body: String,
    pub kind: NodeKind,
    pub size: BubbleSize,
    /// Always resolved; never `Auto` once thrown.
    pub shape: BubbleShape,
    pub on_poke: PokeAction,
    pub linger_ms: u32,
    pub delay_ms: u32,
    pub screen: ScreenAim,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProposedNode {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub weight: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
}

/// What an agent hands to the board in one go. This is the whole "reply":
/// fragments plus the form it chose. `reply` is only an aside.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PresentPayload {
    #[serde(default)]
    pub source_id: Option<String>,
    /// Short aside. Never the main work.
    #[serde(default, alias = "voice")]
    pub reply: String,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub form: Option<String>,
    #[serde(default)]
    pub nodes: Vec<ProposedNode>,
    /// `None` = the agent did not decide (stay quiet on the desktop).
    /// `Some([])` = decided not to interrupt.
    /// `Some([..])` = the only bubbles that may appear. Never implied from `nodes`.
    #[serde(default)]
    pub throws: Option<Vec<ProposedThrow>>,
    /// Grow the new fragments around this existing one.
    #[serde(default)]
    pub focus_node_id: Option<String>,
    /// Bring the board forward in focus mode right away.
    #[serde(default)]
    pub open: bool,
    /// Start from an empty board before placing these fragments.
    #[serde(default)]
    pub replace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresentResult {
    pub reply: String,
    #[serde(default)]
    pub topic: Option<String>,
    pub form: StageForm,
    pub form_reason: String,
    pub nodes: Vec<BoardNode>,
    pub edges: Vec<BoardEdge>,
    #[serde(default)]
    pub throws: Vec<ThrownBubble>,
    pub open: bool,
}

/// One bubble the agent throws on its own, usually mid-task, unrelated to a present.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BubbleRequest {
    /// Stable originating task id; feedback is delivered back to this source.
    #[serde(default)]
    pub source_id: Option<String>,
    pub tease: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
    /// orb | pill | card | sticky | speech | code. Absent = pick from the content.
    #[serde(default)]
    pub shape: Option<String>,
    #[serde(default)]
    pub on_poke: Option<String>,
    #[serde(default)]
    pub screen: Option<String>,
    /// Seconds before it fades on its own.
    #[serde(default)]
    pub linger: Option<u32>,
    /// Attach to a fragment already on the board.
    #[serde(default)]
    pub node_id: Option<String>,
    /// Seconds the tool call may block waiting for a poke. 0 = return at once.
    #[serde(default)]
    pub wait: Option<u32>,
}

/// What the user typed for the agent: from a popped bubble, or from the board's composer.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SayRequest {
    pub text: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub reply_id: Option<String>,
    #[serde(default)]
    pub block_id: Option<String>,
    #[serde(default)]
    pub bubble_id: Option<String>,
    #[serde(default)]
    pub node_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardSnapshot {
    pub topic: String,
    pub form: StageForm,
    pub form_reason: String,
    pub nodes: Vec<BoardNode>,
    pub edges: Vec<BoardEdge>,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub replies: Vec<crate::reply::BoardReply>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryItem {
    pub id: String,
    pub title: String,
    pub text: String,
    pub created_at_ms: u64,
}

impl Default for BoardSnapshot {
    fn default() -> Self {
        Self {
            topic: String::new(),
            form: StageForm::Constellation,
            form_reason: String::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
            messages: Vec::new(),
            replies: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportRequest {
    pub transcript: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetFormRequest {
    pub form: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NodeDraft {
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub weight: Option<String>,
    #[serde(default)]
    pub x: Option<f32>,
    #[serde(default)]
    pub y: Option<f32>,
    #[serde(default)]
    pub z: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NodePatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub weight: Option<String>,
    #[serde(default)]
    pub x: Option<f32>,
    #[serde(default)]
    pub y: Option<f32>,
    #[serde(default)]
    pub z: Option<f32>,
}

#[derive(Debug, thiserror::Error)]
pub enum SpellcastError {
    #[error("{0}")]
    User(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl SpellcastError {
    pub fn user(msg: impl Into<String>) -> Self {
        Self::User(msg.into())
    }
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn forms() -> Vec<FormInfo> {
    vec![
        FormInfo {
            id: "constellation".into(),
            label: "星散".into(),
            blurb: "碎点子摊在平面上。还没长成结构时，这是最诚实的形式。".into(),
        },
        FormInfo {
            id: "spatial".into(),
            label: "立体".into(),
            blurb: "Three.js 空间。关系、系统和互相牵扯的想法用深度说话。".into(),
        },
        FormInfo {
            id: "timeline".into(),
            label: "时序".into(),
            blurb: "一条能走的路径。先后、因果、故事节拍。".into(),
        },
        FormInfo {
            id: "stack".into(),
            label: "并置".into(),
            blurb: "几个方案并着看，拒绝写成一篇取舍作文。".into(),
        },
    ]
}
