use orbit_core::types::{BubbleSize, ScreenAim, ThrownBubble};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BubbleFlight {
    pub item: ThrownBubble,
    pub x: f64,
    #[serde(rename = "startY")]
    pub start_y: f64,
    #[serde(rename = "endY")]
    pub end_y: f64,
}

/// One bubble is one tiny always-on-top window. Not a full-screen overlay.
pub fn list_screens(app: &AppHandle) -> Result<Vec<DesktopScreen>, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "Orbit 主窗口还没起来。".to_string())?;
    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("没有读到显示器。".into());
    }
    let primary = win.primary_monitor().ok().flatten();
    let current = win.current_monitor().ok().flatten();
    let primary_name = primary.as_ref().and_then(|m| m.name().map(|s| s.to_string()));
    let current_name = current.as_ref().and_then(|m| m.name().map(|s| s.to_string()));

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
                is_primary: primary_name.as_deref() == Some(name.as_str()) || (index == 0 && primary_name.is_none()),
                is_active: current_name.as_deref() == Some(name.as_str()),
            }
        })
        .collect())
}

fn work_area_logical(monitor: &tauri::Monitor) -> (f64, f64, f64, f64, f64) {
    let scale = monitor.scale_factor();
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

fn bubble_px(size: BubbleSize) -> f64 {
    match size {
        BubbleSize::Whisper => 86.0,
        BubbleSize::Flare => 168.0,
        BubbleSize::Note => 128.0,
    }
}

pub fn spawn_bubble(app: &AppHandle, item: ThrownBubble) -> Result<(), String> {
    let screens = list_screens(app)?;
    let screen = pick_screen(&screens, item.screen);
    let size = bubble_px(item.size);
    let pad = 20.0;
    let span = (screen.work_w - size - pad * 2.0).max(40.0);
    let x = screen.work_x + pad + js_random() * span;
    let start_y = screen.work_y + screen.work_h - size - pad;
    let end_y = screen.work_y + pad;
    let label = format!(
        "bubble-{}",
        item.id.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect::<String>()
    );

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
    }

    let flight = BubbleFlight {
        item,
        x,
        start_y,
        end_y,
    };

    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("bubble.html".into()))
        .title("Orbit")
        .inner_size(size, size)
        .position(x, start_y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;

    let _ = win.set_size(LogicalSize::new(size, size));
    let _ = win.set_position(LogicalPosition::new(x, start_y));
    win.emit("orbit-flight", &flight)
        .map_err(|e| e.to_string())?;
    Ok(())
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
