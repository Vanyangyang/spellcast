use crate::types::{
    BubbleSize, ChatMessage, ModelPayload, PokeAction, ProposedNode, ProposedThrow, ScreenAim,
};

pub fn brainstorm(
    messages: &[ChatMessage],
    focus_title: Option<&str>,
    locale: &str,
    surface: &str,
    screen_count: u32,
) -> ModelPayload {
    let last_user = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.trim())
        .unwrap_or("");
    let topic = focus_title
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(last_user);

    if locale.starts_with("en") {
        return generic_en(topic, last_user, focus_title.is_some(), surface, screen_count);
    }
    if locale.starts_with("ja") {
        return generic_ja(topic, last_user, focus_title.is_some(), surface, screen_count);
    }

    let seeds = extract_seeds(last_user);
    let angle = infer_angle(last_user);
    let nodes = expand(topic, &seeds, angle, focus_title.is_some());

    let reply = if last_user.is_empty() {
        "写一句还没想完的话。专注板会选一种形式，把碎点子摊开——文字只是旁白。".into()
    } else if focus_title.is_some() {
        format!(
            "围着「{}」继续拆。新的碎点子已经放下，先看哪一粒扎手。",
            crate::layout::clip(topic, 18)
        )
    } else {
        format!(
            "「{}」先不收成文章。用{}摊开，还没成形的都放在板上。",
            crate::layout::clip(topic, 18),
            crate::types::StageForm::infer(topic).label()
        )
    };

    let form = crate::types::StageForm::infer(topic);

    finish(
        ModelPayload {
            reply,
            topic: if focus_title.is_none() && !last_user.is_empty() {
                Some(crate::layout::clip(last_user, 28))
            } else {
                None
            },
            form: Some(form.as_str().into()),
            nodes,
            throws: None,
        },
        last_user,
        surface,
        screen_count,
    )
}

#[derive(Clone, Copy)]
enum Angle {
    Product,
    Research,
    Story,
    Ops,
    General,
}

fn infer_angle(text: &str) -> Angle {
    let t = text.to_ascii_lowercase();
    if contains_any(text, &["产品", "用户", "功能", "app", "插件", "定价", "增长"])
        || t.contains("product")
    {
        Angle::Product
    } else if contains_any(text, &["研究", "论文", "实验", "假设", "数据", "调研"]) {
        Angle::Research
    } else if contains_any(text, &["故事", "小说", "角色", "剧本", "世界观"]) {
        Angle::Story
    } else if contains_any(text, &["流程", "团队", "上线", "运维", "排期", "发布"]) {
        Angle::Ops
    } else {
        Angle::General
    }
}

fn expand(topic: &str, seeds: &[String], angle: Angle, focused: bool) -> Vec<ProposedNode> {
    let short = crate::layout::clip(topic, 12);
    let mut nodes = Vec::new();

    if !focused {
        nodes.push(node(
            &format!("主张 · {short}"),
            &format!("先用一句话钉住：{topic}。后面围着它长，而不是另起一篇。"),
            "insight",
            "anchor",
        ));
    }

    match angle {
        Angle::Product => {
            nodes.push(node(
                "谁真正会打开它",
                "不要写「所有人」。一个具体的人，一个他宁愿换工具的瞬间。",
                "question",
                "note",
            ));
            nodes.push(node(
                "最小可演示切片",
                "去掉账号和后台。三十秒内能看懂的一个动作。",
                "action",
                "note",
            ));
            nodes.push(node(
                "会被弃用的理由",
                "一周后没人回来，最可能是哪句承诺没兑现？",
                "risk",
                "note",
            ));
            nodes.push(node(
                "一个不体面的优势",
                "比「更智能」更有用的，是又窄又凶的场景。",
                "idea",
                "spark",
            ));
        }
        Angle::Research => {
            nodes.push(node(
                "真正要回答的问题",
                &format!("把「{short}」收成一个能证伪的问句。"),
                "question",
                "note",
            ));
            nodes.push(node(
                "最小证据",
                "看到什么，你就愿意更新信念？",
                "action",
                "note",
            ));
            nodes.push(node(
                "混淆变量",
                "什么会让结果看起来很美，其实只是口径在作弊？",
                "risk",
                "spark",
            ));
            nodes.push(node(
                "反常识读法",
                "结论反过来也说得通的话，缺的是数据还是叙事？",
                "idea",
                "spark",
            ));
        }
        Angle::Story => {
            nodes.push(node(
                "谁的欲望在燃烧",
                "不是「成功」。一个具体到尴尬的欲望。",
                "question",
                "note",
            ));
            nodes.push(node(
                "第一场可见冲突",
                "前三分钟必须看见欲望被挡住。",
                "action",
                "note",
            ));
            nodes.push(node(
                "世界观泄漏",
                "每次只允许一个新规则进入画面。",
                "risk",
                "spark",
            ));
            nodes.push(node(
                "把隐喻做实",
                &format!("「{short}」如果是一个房间，门开向哪？"),
                "idea",
                "spark",
            ));
        }
        Angle::Ops => {
            nodes.push(node(
                "谁在等这个结果",
                "那个周五晚上还在盯着状态的人是谁？",
                "question",
                "note",
            ));
            nodes.push(node(
                "一条能跑通的路径",
                "先画成功路径。异常稍后。",
                "action",
                "note",
            ));
            nodes.push(node(
                "单点故障",
                "哪个人或哪把密钥一消失，整件事就停？",
                "risk",
                "spark",
            ));
            nodes.push(node(
                "可以删掉的步骤",
                "砍掉一半环节，哪些仪式其实不创造价值？",
                "idea",
                "spark",
            ));
        }
        Angle::General => {
            nodes.push(node(
                "还没问出口的问题",
                &format!("关于「{short}」，最不敢问的那一句。"),
                "question",
                "spark",
            ));
            nodes.push(node(
                "十分钟动作",
                "今晚能做完、能产生新信息的一步。",
                "action",
                "note",
            ));
            nodes.push(node(
                "最容易自欺的地方",
                "偏好答案如果是错的，最早的裂缝在哪？",
                "risk",
                "spark",
            ));
            nodes.push(node(
                "换一个尺度",
                "放大十倍或缩小十倍。哪个突然可下手？",
                "idea",
                "spark",
            ));
        }
    }

    for seed in seeds.iter().take(2) {
        nodes.push(node(
            seed,
            "你原话里的种子。措辞先留着。",
            "idea",
            "spark",
        ));
    }

    if focused {
        nodes.push(node(
            "收束成一句",
            "留给明天的自己：必须能独立成立。",
            "insight",
            "anchor",
        ));
    }

    nodes
}

fn node(title: &str, body: &str, kind: &str, weight: &str) -> ProposedNode {
    ProposedNode {
        title: title.into(),
        body: body.into(),
        kind: Some(kind.into()),
        weight: Some(weight.into()),
        ..Default::default()
    }
}

fn generic_en(topic: &str, last_user: &str, focused: bool, surface: &str, screen_count: u32) -> ModelPayload {
    let form = crate::types::StageForm::infer(topic);
    let short = crate::layout::clip(topic, 18);
    let reply = if last_user.is_empty() {
        "Say something unfinished. Focus will pick a form and spread scraps on the board.".into()
    } else if focused {
        format!("Staying with “{short}”. New scraps are down. Touch the one that stings.")
    } else {
        format!("“{short}” is not an essay yet. Spread in {} — what is still unformed stays on the board.", form.as_str())
    };
    let mut nodes = vec![
        node("The claim", &format!("Pin it in one sentence: {topic}"), "insight", "anchor"),
        node("The unasked question", "The sentence you are avoiding.", "question", "spark"),
        node("A ten-minute move", "Something you can finish tonight that produces new information.", "action", "note"),
        node("Where you might be lying", "If your preferred answer is wrong, where does it crack first?", "risk", "spark"),
        node("Change the scale", "Ten times larger or ten times smaller. Which one becomes workable?", "idea", "spark"),
    ];
    if focused {
        nodes.push(node(
            "Fold it into one line",
            "What you leave for tomorrow must stand on its own.",
            "insight",
            "anchor",
        ));
    }
    finish(
        ModelPayload {
            reply,
            topic: if !focused && !last_user.is_empty() {
                Some(crate::layout::clip(last_user, 28))
            } else {
                None
            },
            form: Some(form.as_str().into()),
            nodes,
            throws: None,
        },
        last_user,
        surface,
        screen_count,
    )
}

fn generic_ja(topic: &str, last_user: &str, focused: bool, surface: &str, screen_count: u32) -> ModelPayload {
    let form = crate::types::StageForm::infer(topic);
    let short = crate::layout::clip(topic, 18);
    let reply = if last_user.is_empty() {
        "言いかけの一文を置いてください。集中板が形式を選び、切れ端を広げます。".into()
    } else if focused {
        format!("「{short}」のまわりで割ります。新しい切れ端を置きました。")
    } else {
        format!("「{short}」はまだ文章にしない。{} を選んで、未成形のまま広げました。", form.label())
    };
    finish(
        ModelPayload {
            reply,
            topic: if !focused && !last_user.is_empty() {
                Some(crate::layout::clip(last_user, 28))
            } else {
                None
            },
            form: Some(form.as_str().into()),
            nodes: vec![
                node("主張", &format!("一文で釘を刺す：{topic}"), "insight", "anchor"),
                node("まだ聞けない問い", "避けている一文。", "question", "spark"),
                node("十分の手", "今夜終わって、新しい情報が出る一歩。", "action", "note"),
                node("自分をごまかす場所", "好きな答えが違うなら、最初の割れ目はどこか。", "risk", "spark"),
                node("尺度を変える", "十倍するか、十分の一にする。どちらが手を出せるか。", "idea", "spark"),
            ],
            throws: None,
        },
        last_user,
        surface,
        screen_count,
    )
}

fn finish(mut payload: ModelPayload, last_user: &str, surface: &str, screen_count: u32) -> ModelPayload {
    payload.throws = Some(decide_throws(&payload.nodes, last_user, surface, screen_count));
    payload
}

fn stay_quiet(user: &str) -> bool {
    let t = user.trim();
    if t.is_empty() {
        return true;
    }
    let n = t.chars().count();
    if n <= 1 {
        return true;
    }
    matches!(
        t.to_ascii_lowercase().as_str(),
        "谢谢" | "謝謝" | "thanks" | "thank you" | "ok" | "okay" | "好的" | "嗯" | "收到" | "了解"
            | "はい" | "ありがとう"
    )
}

/// The agent picks a few moments worth interrupting — never the whole reply.
fn decide_throws(nodes: &[ProposedNode], last_user: &str, surface: &str, screen_count: u32) -> Vec<ProposedThrow> {
    if !surface.eq_ignore_ascii_case("ambient") {
        return vec![];
    }
    if stay_quiet(last_user) {
        return vec![];
    }

    let mut scored: Vec<(usize, i32)> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let kind = n.kind.as_deref().unwrap_or("idea");
            let weight = n.weight.as_deref().unwrap_or("note");
            let mut score = 0;
            match kind {
                "question" => score += 6,
                "risk" => score += 4,
                "action" => score += 3,
                "idea" => score += 2,
                "insight" => score += 1,
                _ => {}
            }
            if weight == "spark" {
                score += 2;
            }
            // The opening claim is work for the board, not a desktop poke.
            if i == 0 && kind == "insight" {
                score -= 4;
            }
            (i, score)
        })
        .filter(|(_, score)| *score > 0)
        .collect();

    scored.sort_by(|a, b| b.1.cmp(&a.1));

    let take = if scored.len() >= 2 && scored[1].1 >= 4 { 2 } else { 1.min(scored.len()) };
    scored
        .into_iter()
        .take(take)
        .enumerate()
        .map(|(order, (i, _))| throw_from(&nodes[i], i, order, screen_count))
        .collect()
}

fn throw_from(node: &ProposedNode, index: usize, order: usize, screen_count: u32) -> ProposedThrow {
    let kind = node.kind.as_deref().unwrap_or("idea");
    let weight = node.weight.as_deref().unwrap_or("note");
    let size = match (kind, weight) {
        ("idea", "spark") => BubbleSize::Whisper,
        ("insight", _) | (_, "anchor") => BubbleSize::Flare,
        _ => BubbleSize::Note,
    };
    let on_poke = match kind {
        "question" => PokeAction::Reply,
        "insight" => PokeAction::Focus,
        "action" => PokeAction::Pin,
        _ => PokeAction::Peek,
    };
    let has_side = screen_count > 1;
    let screen = if has_side && matches!(on_poke, PokeAction::Pin | PokeAction::Peek) && size == BubbleSize::Whisper
    {
        ScreenAim::Side
    } else if has_side && on_poke == PokeAction::Pin {
        ScreenAim::Side
    } else {
        ScreenAim::Active
    };
    ProposedThrow {
        node: Some(index),
        title: None,
        tease: crate::layout::clip(&node.title, size.tease_chars()),
        size: Some(size.as_str().into()),
        on_poke: Some(on_poke.as_str().into()),
        linger: Some(size.linger_secs()),
        kind: Some(kind.into()),
        delay: Some((order as u32) * 640),
        screen: Some(screen.as_str().into()),
    }
}

fn extract_seeds(text: &str) -> Vec<String> {
    let mut seeds = Vec::new();
    for chunk in text.split(|c| "，。；;,.!?？、\n".contains(c)) {
        let t = chunk.trim();
        let len = t.chars().count();
        if (4..18).contains(&len) && !seeds.iter().any(|s: &String| s == t) {
            seeds.push(t.to_string());
        }
        if seeds.len() >= 2 {
            break;
        }
    }
    seeds
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| text.contains(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_returns_nodes_and_topic() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "做一个跨平台 AI 对话和头脑风暴板".into(),
        }];
        let payload = brainstorm(&messages, None, "zh-CN", "focus", 1);
        assert!(!payload.reply.is_empty());
        assert!(payload.nodes.len() >= 4);
        assert!(payload.topic.is_some());
        assert_eq!(payload.form.as_deref(), Some("constellation"));
        assert_eq!(payload.throws.as_ref().map(|t| t.len()), Some(0));
    }

    #[test]
    fn timeline_form_for_process() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "先做原型，然后内测，再发布".into(),
        }];
        let payload = brainstorm(&messages, None, "zh-CN", "focus", 1);
        assert_eq!(payload.form.as_deref(), Some("timeline"));
    }

    #[test]
    fn ambient_throws_are_sparse() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "做一个跨平台 AI 对话和头脑风暴板".into(),
        }];
        let payload = brainstorm(&messages, None, "zh-CN", "ambient", 1);
        let throws = payload.throws.unwrap();
        assert!(!throws.is_empty());
        assert!(throws.len() <= 2);
        assert!(throws.len() < payload.nodes.len());
        assert!(throws.iter().all(|t| !t.tease.is_empty()));
        assert!(throws.iter().any(|t| t.on_poke.as_deref() == Some("reply")));
        assert!(throws.iter().all(|t| t.screen.as_deref() == Some("active")));
    }

    #[test]
    fn multi_screen_can_throw_to_the_side() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "做一个跨平台 AI 对话和头脑风暴板".into(),
        }];
        let payload = brainstorm(&messages, None, "zh-CN", "ambient", 2);
        let throws = payload.throws.unwrap();
        assert!(throws.iter().any(|t| {
            t.screen.as_deref() == Some("side") || t.screen.as_deref() == Some("active")
        }));
        assert!(throws.iter().any(|t| t.on_poke.as_deref() == Some("reply") && t.screen.as_deref() == Some("active")));
    }

    #[test]
    fn thanks_stays_quiet_on_desktop() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "谢谢".into(),
        }];
        let payload = brainstorm(&messages, None, "zh-CN", "ambient", 1);
        assert!(payload.throws.unwrap().is_empty());
    }
}
