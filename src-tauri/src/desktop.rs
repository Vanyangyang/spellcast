use serde::{Deserialize, Serialize};
use spellcast_core::types::{BubbleShape, BubbleSize, ScreenAim, ThrownBubble};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopScreen {
    pub index: usize,
    pub name: String,
    pub scale: f64,
    pub work_x: f64,
    pub work_y: f64,
    pub work_w: f64,
    pub work_h: f64,
    pub is_primary: bool,
    pub is_active: bool,
}

/// The screen's usable rectangle, in logical pixels, so the page can re-fit the
/// window once it knows how big its words actually are.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WorkArea {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BubbleFlight {
    pub item: ThrownBubble,
    pub x: f64,
    #[serde(rename = "startY")]
    pub start_y: f64,
    #[serde(rename = "endY")]
    pub end_y: f64,
    pub work: WorkArea,
    pub margin: f64,
    pub pad: f64,
}

/// One bubble is one tiny always-on-top window. Not a full-screen overlay.
pub fn list_screens(app: &AppHandle) -> Result<Vec<DesktopScreen>, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "Spellcast 主窗口还没起来。".to_string())?;
    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("没有读到显示器。".into());
    }
    let primary = win.primary_monitor().ok().flatten();
    let current = win.current_monitor().ok().flatten();
    let primary_name = primary
        .as_ref()
        .and_then(|m| m.name().map(|s| s.to_string()));
    let current_name = current
        .as_ref()
        .and_then(|m| m.name().map(|s| s.to_string()));

    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let (work_x, work_y, work_w, work_h, scale) = work_area_logical(monitor);
            let name = monitor
                .name()
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("display-{index}"));
            DesktopScreen {
                index,
                name: name.clone(),
                scale,
                work_x,
                work_y,
                work_w,
                work_h,
                is_primary: primary_name.as_deref() == Some(name.as_str())
                    || (index == 0 && primary_name.is_none()),
                is_active: current_name.as_deref() == Some(name.as_str()),
            }
        })
        .collect())
}

fn work_area_logical(monitor: &tauri::Monitor) -> (f64, f64, f64, f64, f64) {
    let scale = monitor.scale_factor();
    // The OS already knows where its taskbar / menu bar / Dock is; trust it
    // instead of guessing. Falls back to a guess only if the area is nonsense.
    let area = monitor.work_area();
    if area.size.width > 0 && area.size.height > 0 {
        return (
            f64::from(area.position.x) / scale,
            f64::from(area.position.y) / scale,
            f64::from(area.size.width) / scale,
            f64::from(area.size.height) / scale,
            scale,
        );
    }
    let pos = monitor.position();
    let size = monitor.size();
    let x = f64::from(pos.x) / scale;
    let y = f64::from(pos.y) / scale;
    let w = f64::from(size.width) / scale;
    let h = f64::from(size.height) / scale;
    let (top, bottom) = if cfg!(target_os = "macos") {
        (28.0, 68.0)
    } else if cfg!(target_os = "windows") {
        (0.0, 48.0)
    } else {
        (0.0, 0.0)
    };
    (x, y + top, w, (h - top - bottom).max(200.0), scale)
}

fn pick_screen(screens: &[DesktopScreen], aim: ScreenAim) -> &DesktopScreen {
    let active = screens.iter().find(|s| s.is_active).unwrap_or(&screens[0]);
    let primary = screens.iter().find(|s| s.is_primary).unwrap_or(&screens[0]);
    match aim {
        ScreenAim::Primary => primary,
        ScreenAim::Side => screens
            .iter()
            .find(|s| s.index != active.index)
            .or_else(|| screens.iter().find(|s| !s.is_active))
            .unwrap_or(active),
        ScreenAim::Active => active,
    }
}

/// The widest a shape may grow before its words wrap. Matches `max-width` in styles.css.
fn max_width(shape: BubbleShape) -> f64 {
    match shape {
        BubbleShape::Orb => 150.0,
        BubbleShape::Pill => 480.0,
        BubbleShape::Card => 340.0,
        BubbleShape::Sticky => 300.0,
        BubbleShape::Speech => 340.0,
        BubbleShape::Code => 460.0,
        BubbleShape::Auto => 340.0,
    }
}

/// A rough guess at the rendered height from the amount of text. The page
/// measures the real thing and resizes; this only has to be big enough that
/// nothing is clipped on the first frame.
fn guess_height(item: &ThrownBubble) -> f64 {
    let scale = match item.size {
        BubbleSize::Whisper => 0.85,
        BubbleSize::Note => 1.0,
        BubbleSize::Flare => 1.2,
    };
    let chars_per_line = (max_width(item.shape) / (17.0 * scale)).max(4.0);
    let lines = |text: &str| {
        (text.chars().count() as f64 / chars_per_line)
            .ceil()
            .max(1.0)
    };
    let mut h = 44.0 + lines(&item.tease) * 24.0 * scale;
    if matches!(
        item.shape,
        BubbleShape::Card | BubbleShape::Sticky | BubbleShape::Speech | BubbleShape::Code
    ) {
        if item.title != item.tease {
            h += 26.0 * scale;
        }
        if item.body != item.tease {
            h += lines(&item.body) * 20.0 * scale + 8.0;
        }
    }
    (h * 1.35 + 40.0).min(560.0)
}

/// Extra transparent room around the bubble so its shadow and the hover lift are not clipped.
const BUBBLE_MARGIN: f64 = 18.0;
const EDGE_PAD: f64 = 20.0;

pub fn spawn_bubble(app: &AppHandle, item: ThrownBubble) -> Result<(), String> {
    let screens = list_screens(app)?;
    let screen = pick_screen(&screens, item.screen);
    let width = (max_width(item.shape) + BUBBLE_MARGIN * 2.0).min(screen.work_w - EDGE_PAD * 2.0);
    let height = (guess_height(&item) + BUBBLE_MARGIN * 2.0).min(screen.work_h - EDGE_PAD * 2.0);
    let pad = EDGE_PAD;
    let span = (screen.work_w - width - pad * 2.0).max(40.0);
    let x = spread_x(app, screen.work_x + pad, span, width);
    let start_y = screen.work_y + screen.work_h - height - pad;
    let end_y = screen.work_y + pad;
    let work = WorkArea {
        x: screen.work_x,
        y: screen.work_y,
        w: screen.work_w,
        h: screen.work_h,
    };
    let label = format!(
        "bubble-{}",
        item.id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(12)
            .collect::<String>()
    );

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
    }

    let flight = BubbleFlight {
        item,
        x,
        start_y,
        end_y,
        work,
        margin: BUBBLE_MARGIN,
        pad,
    };
    // Hand the flight over before any script runs. An event emitted right after
    // `build()` races the page load and is lost if the listener is not up yet.
    let flight_json = serde_json::to_string(&flight).map_err(|e| e.to_string())?;
    let init = format!("window.__SPELLCAST_FLIGHT__ = {flight_json};");

    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("bubble.html".into()))
        .title("Spellcast Bubble")
        .initialization_script(&init)
        .inner_size(width, height)
        .position(x, start_y)
        .decorations(false)
        .shadow(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;

    let _ = win.set_size(LogicalSize::new(width, height));
    let _ = win.set_position(LogicalPosition::new(x, start_y));
    // Belt and braces for a page that is already listening.
    let _ = win.emit("spellcast-flight", &flight);
    Ok(())
}

/// Several bubbles thrown close together must not land on top of each other.
/// Pick the candidate column farthest from every bubble already on screen,
/// jittered a little so the desk never looks like a grid.
fn spread_x(app: &AppHandle, left: f64, span: f64, width: f64) -> f64 {
    let taken: Vec<f64> = app
        .webview_windows()
        .iter()
        .filter(|(label, _)| label.starts_with("bubble-"))
        .filter_map(|(_, win)| {
            let scale = win.scale_factor().unwrap_or(1.0);
            let pos = win.outer_position().ok()?;
            let size = win.outer_size().ok()?;
            Some(f64::from(pos.x) / scale + f64::from(size.width) / scale / 2.0)
        })
        .collect();
    let jitter = (js_random() - 0.5) * span * 0.12;
    if taken.is_empty() {
        return left + js_random() * span;
    }
    let candidates = [0.08, 0.26, 0.44, 0.62, 0.8, 0.96];
    let mut best = left + js_random() * span;
    let mut best_gap = f64::MIN;
    for c in candidates {
        let x = (left + span * c + jitter).clamp(left, left + span);
        let centre = x + width / 2.0;
        let gap = taken
            .iter()
            .map(|t| (t - centre).abs())
            .fold(f64::MAX, f64::min);
        if gap > best_gap {
            best_gap = gap;
            best = x;
        }
    }
    best
}

pub fn close_bubbles(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("bubble-") {
            let _ = win.close();
        }
    }
}

fn js_random() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(1);
    (f64::from(nanos % 10_000) / 10_000.0).clamp(0.0, 0.999)
}
