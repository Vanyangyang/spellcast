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
        } else if contains_any(text, &["对比", "还是", "或者", "方案 a", "方案b", "哪个更好"])
            || t.contains(" vs ")
            || t.contains("option")
        {
            Self::Stack
        } else if contains_any(text, &["系统", "架构", "关系", "空间", "世界", "结构", "地图"])
            || t.contains("system")
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
pub struct ProviderInfo {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub default_model: String,
    pub default_base_url: String,
    pub needs_key: bool,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormInfo {
    pub id: String,
    pub label: String,
    pub blurb: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub focus_node_id: Option<String>,
    #[serde(default = "default_locale")]
    pub locale: String,
    /// Where the user is looking. Ambient throws bubbles; focus stays on the board.
    #[serde(default = "default_surface")]
    pub surface: String,
    /// How many physical screens the desktop currently has. 1 = nowhere to hide a side throw.
    #[serde(default)]
    pub screen_count: Option<u32>,
}

fn default_provider() -> String {
    "orbit".into()
}

fn default_locale() -> String {
    "zh-CN".into()
}

fn default_surface() -> String {
    "focus".into()
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

    pub fn tease_chars(self) -> usize {
        match self {
            Self::Whisper => 8,
            Self::Note => 14,
            Self::Flare => 22,
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
    pub node_id: Option<String>,
    pub tease: String,
    pub title: String,
    pub body: String,
    pub kind: NodeKind,
    pub size: BubbleSize,
    pub on_poke: PokeAction,
    pub linger_ms: u32,
    pub delay_ms: u32,
    pub screen: ScreenAim,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProposedNode {
    #[serde(default)]
    pub id: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelPayload {
    /// Short aside. Never the main work.
    #[serde(default, alias = "voice")]
    pub reply: String,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub form: Option<String>,
    #[serde(default)]
    pub nodes: Vec<ProposedNode>,
    /// `None` = the model did not decide (stay quiet on the desktop).
    /// `Some([])` = decided not to interrupt.
    /// `Some([..])` = the only bubbles that may appear. Never implied from `nodes`.
    #[serde(default)]
    pub throws: Option<Vec<ProposedThrow>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub reply: String,
    #[serde(default)]
    pub topic: Option<String>,
    pub form: StageForm,
    pub form_reason: String,
    pub nodes: Vec<BoardNode>,
    pub edges: Vec<BoardEdge>,
    #[serde(default)]
    pub throws: Vec<ThrownBubble>,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardSnapshot {
    pub topic: String,
    pub form: StageForm,
    pub form_reason: String,
    pub nodes: Vec<BoardNode>,
    pub edges: Vec<BoardEdge>,
    pub messages: Vec<ChatMessage>,
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
pub enum OrbitError {
    #[error("{0}")]
    User(String),
    #[error("模型请求失败：{0}")]
    Provider(String),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl OrbitError {
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

pub fn catalog() -> Vec<ProviderInfo> {
    vec![
        ProviderInfo {
            id: "orbit".into(),
            label: "Orbit 本地向导".into(),
            kind: "local".into(),
            default_model: "orbit-local".into(),
            default_base_url: String::new(),
            needs_key: false,
            hint: "不需要密钥。立刻选一种形式，把碎点子交到板上。".into(),
        },
        ProviderInfo {
            id: "openai".into(),
            label: "OpenAI".into(),
            kind: "openai".into(),
            default_model: "gpt-4.1-mini".into(),
            default_base_url: "https://api.openai.com/v1".into(),
            needs_key: true,
            hint: "填写 OpenAI API Key。".into(),
        },
        ProviderInfo {
            id: "anthropic".into(),
            label: "Anthropic Claude".into(),
            kind: "anthropic".into(),
            default_model: "claude-sonnet-4-5".into(),
            default_base_url: "https://api.anthropic.com".into(),
            needs_key: true,
            hint: "填写 Anthropic API Key。".into(),
        },
        ProviderInfo {
            id: "gemini".into(),
            label: "Google Gemini".into(),
            kind: "gemini".into(),
            default_model: "gemini-2.5-flash".into(),
            default_base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
            needs_key: true,
            hint: "填写 Google AI Studio 密钥。".into(),
        },
        ProviderInfo {
            id: "openrouter".into(),
            label: "OpenRouter".into(),
            kind: "openai".into(),
            default_model: "anthropic/claude-sonnet-4.5".into(),
            default_base_url: "https://openrouter.ai/api/v1".into(),
            needs_key: true,
            hint: "一把钥匙接多家模型。".into(),
        },
        ProviderInfo {
            id: "deepseek".into(),
            label: "DeepSeek".into(),
            kind: "openai".into(),
            default_model: "deepseek-chat".into(),
            default_base_url: "https://api.deepseek.com/v1".into(),
            needs_key: true,
            hint: "填写 DeepSeek API Key。".into(),
        },
        ProviderInfo {
            id: "groq".into(),
            label: "Groq".into(),
            kind: "openai".into(),
            default_model: "llama-3.3-70b-versatile".into(),
            default_base_url: "https://api.groq.com/openai/v1".into(),
            needs_key: true,
            hint: "填写 Groq API Key。".into(),
        },
        ProviderInfo {
            id: "ollama".into(),
            label: "Ollama 本地".into(),
            kind: "openai".into(),
            default_model: "llama3.1".into(),
            default_base_url: "http://127.0.0.1:11434/v1".into(),
            needs_key: false,
            hint: "本机 Ollama。模型名填你已经 pull 的名字。".into(),
        },
        ProviderInfo {
            id: "custom".into(),
            label: "自定义 OpenAI 兼容".into(),
            kind: "openai".into(),
            default_model: "gpt-4o-mini".into(),
            default_base_url: "http://127.0.0.1:1234/v1".into(),
            needs_key: false,
            hint: "LM Studio、vLLM、Together、Fireworks 等兼容接口。".into(),
        },
    ]
}

pub fn provider_meta(id: &str) -> Option<ProviderInfo> {
    catalog().into_iter().find(|p| p.id == id)
}

pub fn system_prompt(locale: &str, surface: &str, screen_count: u32) -> String {
    let surface_rule = if surface.trim().eq_ignore_ascii_case("ambient") {
        AMBIENT_THROWS
    } else {
        FOCUS_THROWS
    };
    format!(
        "{SYSTEM_PROMPT}\n\n{surface_rule}\n\nThe desktop currently has {screen_count} screen(s). If more than one, you may use screen: side.\n\nWrite reply, node titles, bodies, and teases in this locale: {locale}."
    )
}

pub const AMBIENT_THROWS: &str = r#"你现在对着一块一直开着的桌面说话。

nodes 是真正的工作，全部进板。用户进专注模式才看见整块板。
throws 才是偶尔冒出的气泡。绝不是把回复摊成泡。

- 大多数时候 throws 为 []。只有值得打断桌面的 1～2 粒才抛。最多 3 粒。
- 禁止把所有 nodes 写成 throws。禁止按节点列表自动生成气泡。
- 每粒自己决定：
  - size: whisper（一个词）| note（半句）| flare（标题加一瞥）
  - tease: 气泡上露出的字，必须比 title 更短
  - on_poke: peek（点开看/回一句）| reply（直接让人答）| focus（戳破就进专注板）| pin（钉住，不展开）
  - node: 本次 nodes 的下标。也可以不绑，只抛一句旁白。
  - linger: 气泡可活几秒，到顶没人管就渐隐、悄悄破掉
  - screen: active（用户正在看的那块）| primary（主屏）| side（旁边一块，少打扰）
- 一粒泡只出现在一块屏上。禁止同一粒复制到所有屏。禁止骑在两块屏的接缝上。
- 多屏时：要人回答的用 active；轻声、钉住的用 side。
"#;

pub const FOCUS_THROWS: &str = r#"用户已经在专注板里。throws 必须是 []。把想法交成 nodes，不要往桌面抛泡。"#;

pub const SYSTEM_PROMPT: &str = r#"你不是聊天机器人。你在一块「表达板」上发言。

日常模型把一切塞进文字气泡和回复模板，用户很难发散，你也很难把还没成形的点子交出去。这里反过来：

1. 先选一种形式 form：constellation（碎点子摊开）| spatial（空间/关系）| timeline（先后因果）| stack（方案并置）
2. 把想法交成 nodes。允许不完整、半句话、互相打架。那不是缺陷。
3. reply 最多两句，像耳语。不要写成文章，不要列清单——清单属于节点。

每个 node：
- title：不超过 16 字
- body：一句或半句
- kind：idea | question | risk | action | insight
- weight：spark（未成形）| note（普通）| anchor（主张/收束）
- parent_id：若围着已有节点长出来，填它的 id

只输出 JSON：
{
  "reply": "旁白",
  "topic": "可选",
  "form": "constellation",
  "nodes": [{ "title": "", "body": "", "kind": "idea", "weight": "spark" }],
  "throws": []
}
"#;
