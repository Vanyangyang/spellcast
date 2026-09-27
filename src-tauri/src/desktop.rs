use serde::{Deserialize, Serialize};
use spellcast_core::types::{BubbleShape, BubbleSize, ThrownBubble};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};

/// Where a bubble window ended up after the user let go, in physical pixels.
/// `moved` is false for a press that never left the OS drag threshold: a click.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct DragOutcome {
    pub x: i32,
    pub y: i32,
    pub moved: bool,
}

/// Resolve only after the native move gesture ends, so animation cannot fight the drag.
#[tauri::command]
pub async fn drag_bubble(window: tauri::WebviewWindow) -> Result<DragOutcome, String> {
    if !window.label().starts_with("bubble-") {
        return Err("Only bubble windows can use this command.".into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let moving = window.clone();
    window
        .run_on_main_thread(move || {
            // Window getters run inline on the main thread in tauri-runtime-wry,
            // so reading the position here cannot wait on the blocked event loop.
            let result = (|| {
                let before = moving.outer_position().map_err(|err| err.to_string())?;
                finish_bubble_drag(&moving)?;
                let after = moving.outer_position().map_err(|err| err.to_string())?;
                Ok(DragOutcome {
                    x: after.x,
                    y: after.y,
                    moved: after != before,
                })
            })();
            let _ = tx.send(result);
        })
        .map_err(|err| err.to_string())?;
    rx.await.map_err(|err| err.to_string())?
}

#[cfg(windows)]
fn finish_bubble_drag(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::POINT,
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, ReleaseCapture, VK_LBUTTON},
            WindowsAndMessaging::{GetCursorPos, SendMessageW, HTCAPTION, WM_NCLBUTTONDOWN},
        },
    };
    let hwnd = window.hwnd().map_err(|err| err.to_string())?.0;
    // SendMessage enters the OS move loop synchronously. Tauri's start_dragging
    // posts this message and returns before release, which is too early here.
    unsafe {
        if GetAsyncKeyState(VK_LBUTTON as i32) >= 0 {
            return Ok(());
        }
        let mut cursor = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut cursor) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let position = ((cursor.y as u16 as u32) << 16) | cursor.x as u16 as u32;
        ReleaseCapture();
        SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION as usize, position as isize);
    }
    Ok(())
}

#[cfg(not(windows))]
fn finish_bubble_drag(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|err| err.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopScreen {
    pub index: usize,
    /// Stable identity used to remember a fixed display across restarts and reconnects.
    pub id: String,
    /// 1-based, left to right then top to bottom, so the number follows the physical layout.
    pub number: usize,
    pub name: String,
    /// The monitor's own model name when the OS reports one; empty otherwise.
    pub label: String,
    /// Monitor bounds in physical pixels, for the settings layout sketch.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
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
    pub scale: f64,
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
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("没有读到显示器。".into());
    }
    let primary = app.primary_monitor().ok().flatten();
    // Look up the user's foreground screen at delivery time. The board may be
    // hidden on another display. During a focus transition, fall back to the
    // pointer's screen, then the primary display; never to the board's position.
    let current = foreground_screen_point()
        .and_then(|(x, y)| app.monitor_from_point(x, y).ok().flatten())
        .or_else(|| {
            let pointer = app.cursor_position().ok()?;
            // Tao's macOS monitor lookup takes Quartz points; its cursor API
            // reports physical pixels scaled against the primary display.
            let scale = if cfg!(target_os = "macos") {
                primary.as_ref().map_or(1.0, |m| m.scale_factor())
            } else {
                1.0
            };
            app.monitor_from_point(pointer.x / scale, pointer.y / scale)
                .ok()
                .flatten()
        })
        .or_else(|| primary.clone());
    let identities = monitor_identities();
    let mut order: Vec<usize> = (0..monitors.len()).collect();
    order.sort_by_key(|&i| (monitors[i].position().x, monitors[i].position().y));

    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let (work_x, work_y, work_w, work_h, scale) = work_area_logical(monitor);
            let name = monitor
                .name()
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("display-{index}"));
            let (position, size) = (monitor.position(), monitor.size());
            let identity = identities.iter().find(|(device, _, _)| *device == name);
            DesktopScreen {
                index,
                id: screen_id(&name, identity.map(|(_, path, _)| path.as_str()), position, size),
                number: order.iter().position(|&i| i == index).unwrap_or(index) + 1,
                label: match identity {
                    Some((_, _, friendly)) => friendly.clone(),
                    // Windows slot names such as \\.\DISPLAY1 are not model names.
                    None if cfg!(windows) => String::new(),
                    None => name.clone(),
                },
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                name: name.clone(),
                scale,
                work_x,
                work_y,
                work_w,
                work_h,
                is_primary: primary.as_ref().is_some_and(|m| same_monitor(monitor, m))
                    || (index == 0 && primary.is_none()),
                is_active: current.as_ref().is_some_and(|m| same_monitor(monitor, m))
                    || (index == 0 && current.is_none()),
            }
        })
        .collect())
}

pub(crate) fn same_monitor(a: &tauri::Monitor, b: &tauri::Monitor) -> bool {
    a.position() == b.position() && a.size() == b.size()
}

/// A remembered display must never match a different panel that later reuses the same
/// OS slot name, so prefer the monitor's device path and include geometry otherwise.
fn screen_id(
    name: &str,
    device_path: Option<&str>,
    position: &tauri::PhysicalPosition<i32>,
    size: &tauri::PhysicalSize<u32>,
) -> String {
    match device_path.filter(|path| !path.is_empty()) {
        Some(path) => format!("path:{path}"),
        None if cfg!(windows) => format!("gdi:{name}@{}x{}", size.width, size.height),
        None => format!(
            "name:{name}@{},{},{}x{}",
            position.x, position.y, size.width, size.height
        ),
    }
}

/// `(GDI device name, monitor device path, friendly model name)` for each active display.
#[cfg(windows)]
fn monitor_identities() -> Vec<(String, String, String)> {
    use windows_sys::Win32::Devices::Display::{
        DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
        DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
        DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
        DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
    };
    let text = |raw: &[u16]| {
        let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
        String::from_utf16_lossy(&raw[..end])
    };
    // Reads display topology only; nothing here touches windows or their content.
    unsafe {
        let (mut path_count, mut mode_count) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
            != 0
        {
            return Vec::new();
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut path_count,
            paths.as_mut_ptr(),
            &mut mode_count,
            modes.as_mut_ptr(),
            std::ptr::null_mut(),
        ) != 0
        {
            return Vec::new();
        }
        paths.truncate(path_count as usize);
        let mut found: Vec<(String, String, String)> = Vec::new();
        for path in &paths {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            source.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            source.header.adapterId = path.sourceInfo.adapterId;
            source.header.id = path.sourceInfo.id;
            let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
            target.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            target.header.size = std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
            target.header.adapterId = path.targetInfo.adapterId;
            target.header.id = path.targetInfo.id;
            if DisplayConfigGetDeviceInfo(&mut source.header) != 0
                || DisplayConfigGetDeviceInfo(&mut target.header) != 0
            {
                continue;
            }
            let device = text(&source.viewGdiDeviceName);
            // A mirrored source drives several panels; keep the first so the id stays stable.
            if found.iter().any(|(known, _, _)| *known == device) {
                continue;
            }
            found.push((
                device,
                text(&target.monitorDevicePath),
                text(&target.monitorFriendlyDeviceName),
            ));
        }
        found
    }
}

#[cfg(not(windows))]
fn monitor_identities() -> Vec<(String, String, String)> {
    Vec::new()
}

#[cfg(windows)]
fn foreground_screen_point() -> Option<(f64, f64)> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    // Read only the foreground handle and its monitor bounds, not app content.
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        Some((
            (f64::from(info.rcMonitor.left) + f64::from(info.rcMonitor.right)) / 2.0,
            (f64::from(info.rcMonitor.top) + f64::from(info.rcMonitor.bottom)) / 2.0,
        ))
    }
}

#[cfg(target_os = "macos")]
fn foreground_screen_point() -> Option<(f64, f64)> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;
    let mtm = MainThreadMarker::new()?;
    let screen = NSScreen::mainScreen(mtm)?;
    let primary = NSScreen::screens(mtm).firstObject()?;
    let frame = screen.frame();
    let top = primary.frame().origin.y + primary.frame().size.height;
    Some((
        frame.origin.x + frame.size.width / 2.0,
        top - (frame.origin.y + frame.size.height / 2.0),
    ))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn foreground_screen_point() -> Option<(f64, f64)> {
    None
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
    let screen = crate::display_target::bubble_screen(app, &screens);
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
        scale: screen.scale,
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
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;

    // Physical coordinates avoid choosing the wrong display when adjacent
    // monitors have different scale factors. Place before showing the window.
    if let Err(err) = win
        .set_position(PhysicalPosition::new(
            (x * screen.scale).round() as i32,
            (start_y * screen.scale).round() as i32,
        ))
        .and_then(|_| win.set_size(LogicalSize::new(width, height)))
        .and_then(|_| win.show())
    {
        let _ = win.close();
        return Err(err.to_string());
    }
    if let Err(err) = crate::completions::keep_in_front(app) {
        eprintln!("Completion window Z order: {err}");
    }
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Opt-in numeric evidence for a real desktop check. Reads window/monitor
    /// geometry only; it never activates, moves, or reads text from a window.
    #[cfg(windows)]
    #[test]
    #[ignore = "requires an interactive Windows desktop"]
    fn live_foreground_monitor() {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect};
        let active = unsafe { GetForegroundWindow() };
        let mut rect = RECT::default();
        let read = unsafe { GetWindowRect(active, &mut rect) } != 0;
        let sample = std::env::var("SPELLCAST_DIAG_WINDOW_ID")
            .ok().and_then(|v| v.parse::<usize>().ok());
        let mut sample_rect = RECT::default();
        let sample_read = sample.is_some_and(|id| unsafe {
            GetWindowRect(id as _, &mut sample_rect) != 0
        });
        println!("{}", serde_json::json!({
            "foreground_window": active as usize,
            "foreground_rect": read.then_some([rect.left, rect.top, rect.right, rect.bottom]),
            "foreground_monitor_point": foreground_screen_point(),
            "sample_window": sample,
            "sample_rect": sample_read.then_some([sample_rect.left, sample_rect.top, sample_rect.right, sample_rect.bottom]),
        }));
        assert!(!active.is_null(), "No foreground window in this desktop session");
        assert!(foreground_screen_point().is_some());
    }

    /// A test display; only the fields placement reads are meaningful.
    pub(crate) fn screen(index: usize, id: &str, is_primary: bool, is_active: bool) -> DesktopScreen {
        DesktopScreen {
            index,
            id: id.into(),
            number: index + 1,
            name: "Same model".into(),
            label: String::new(),
            x: index as i32 * 1920,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
            work_x: index as f64 * 1920.0,
            work_y: 0.0,
            work_w: 1920.0,
            work_h: 1040.0,
            is_primary,
            is_active,
        }
    }

    /// Opt-in evidence that each active display gets a device path and model name.
    #[cfg(windows)]
    #[test]
    #[ignore = "requires an interactive Windows desktop"]
    fn live_monitor_identities() {
        let found = monitor_identities();
        println!("{}", serde_json::json!(found));
        assert!(!found.is_empty(), "QueryDisplayConfig reported no active display");
        assert!(found.iter().all(|(device, path, _)| device.starts_with(r"\\.\") && !path.is_empty()));
    }

}
