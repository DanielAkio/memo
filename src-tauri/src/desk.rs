//! Desktop coordinates for dragging, the magnet, Snap and resizing: one space
//! in which the cursor, every window and every monitor can be compared.
//!
//! Windows and Linux: physical pixels, which Tauri already uses everywhere.
//!
//! macOS: Tauri's "physical" values are not one space there. The desktop is
//! laid out in points; a window's position and size come as points × that
//! window's scale, a monitor's as points × that monitor's scale, and the
//! cursor as points × the main monitor's scale. With a Retina screen and an
//! external 1× monitor, a window dragged on the external one followed the
//! cursor at twice its speed. Here everything is points × the main monitor's
//! scale (the cursor's space), which on a single monitor is exactly what
//! Tauri reports, so saved positions keep their meaning.

#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, LogicalSize};
use tauri::{Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

/// The main monitor's scale: desktop units per point (macOS).
#[cfg(target_os = "macos")]
fn main_scale(window: &WebviewWindow) -> f64 {
    window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0)
}

/// Converts a value Tauri reported in pixels of `scale` to desktop units.
#[cfg(target_os = "macos")]
fn from(window: &WebviewWindow, v: f64, scale: f64) -> f64 {
    v / scale * main_scale(window)
}

/// The window's own scale (what Tauri multiplied its position and size by).
#[cfg(target_os = "macos")]
fn own_scale(window: &WebviewWindow) -> f64 {
    window.scale_factor().unwrap_or(1.0)
}

/// Desktop units per logical pixel where the window is: the monitor's scale
/// on Windows and Linux, the main monitor's on macOS (points are logical
/// pixels there).
pub fn scale(window: &WebviewWindow) -> f64 {
    #[cfg(target_os = "macos")]
    return main_scale(window);
    #[cfg(not(target_os = "macos"))]
    window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .or_else(|| window.scale_factor().ok())
        .unwrap_or(1.0)
}

/// Desktop units per logical pixel on `monitor` (see `scale`).
pub fn monitor_scale(window: &WebviewWindow, monitor: &Monitor) -> f64 {
    #[cfg(target_os = "macos")]
    {
        let _ = monitor;
        main_scale(window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        monitor.scale_factor()
    }
}

pub fn cursor(window: &WebviewWindow) -> Option<(f64, f64)> {
    // Already in the desktop space on every system (see the module docs).
    let c = window.cursor_position().ok()?;
    Some((c.x, c.y))
}

/// A position Tauri reported for `window` (e.g. in `WindowEvent::Moved`).
pub fn point(window: &WebviewWindow, p: PhysicalPosition<i32>) -> (i32, i32) {
    #[cfg(target_os = "macos")]
    {
        let s = own_scale(window);
        (
            from(window, p.x as f64, s).round() as i32,
            from(window, p.y as f64, s).round() as i32,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        (p.x, p.y)
    }
}

fn size(window: &WebviewWindow, s: PhysicalSize<u32>) -> (i32, i32) {
    #[cfg(target_os = "macos")]
    {
        let k = own_scale(window);
        (
            from(window, s.width as f64, k).round() as i32,
            from(window, s.height as f64, k).round() as i32,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        (s.width as i32, s.height as i32)
    }
}

pub fn outer_position(window: &WebviewWindow) -> Option<(i32, i32)> {
    Some(point(window, window.outer_position().ok()?))
}

pub fn inner_position(window: &WebviewWindow) -> Option<(i32, i32)> {
    Some(point(window, window.inner_position().ok()?))
}

pub fn inner_size(window: &WebviewWindow) -> Option<(i32, i32)> {
    Some(size(window, window.inner_size().ok()?))
}

pub fn outer_size(window: &WebviewWindow) -> Option<(i32, i32)> {
    Some(size(window, window.outer_size().ok()?))
}

pub fn set_position(window: &WebviewWindow, x: i32, y: i32) {
    #[cfg(target_os = "macos")]
    {
        let k = main_scale(window);
        let _ = window.set_position(LogicalPosition::new(x as f64 / k, y as f64 / k));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

pub fn set_size(window: &WebviewWindow, w: i32, h: i32) {
    #[cfg(target_os = "macos")]
    {
        let k = main_scale(window);
        let _ = window.set_size(LogicalSize::new(w as f64 / k, h as f64 / k));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_size(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
    }
}

/// A monitor in desktop units: whole area and work area as (x, y, w, h).
pub struct Screen {
    pub area: (i32, i32, i32, i32),
    pub work: (i32, i32, i32, i32),
    /// Desktop units per logical pixel (see `scale`).
    pub scale: f64,
}

impl Screen {
    fn new(window: &WebviewWindow, m: &Monitor) -> Self {
        #[cfg(target_os = "macos")]
        let conv = |v: i32| from(window, v as f64, m.scale_factor()).round() as i32;
        #[cfg(not(target_os = "macos"))]
        let conv = |v: i32| v;
        let (p, s, a) = (m.position(), m.size(), m.work_area());
        Self {
            area: (
                conv(p.x),
                conv(p.y),
                conv(s.width as i32),
                conv(s.height as i32),
            ),
            work: (
                conv(a.position.x),
                conv(a.position.y),
                conv(a.size.width as i32),
                conv(a.size.height as i32),
            ),
            scale: monitor_scale(window, m),
        }
    }

    pub fn contains(&self, (x, y): (f64, f64)) -> bool {
        let (l, t, w, h) = self.area;
        x >= l as f64 && x < (l + w) as f64 && y >= t as f64 && y < (t + h) as f64
    }

    pub fn work_contains(&self, (x, y): (i32, i32)) -> bool {
        let (l, t, w, h) = self.work;
        x >= l && x < l + w && y >= t && y < t + h
    }
}

pub fn screens(window: &WebviewWindow) -> Vec<Screen> {
    window
        .available_monitors()
        .map(|ms| ms.iter().map(|m| Screen::new(window, m)).collect())
        .unwrap_or_default()
}

pub fn current_screen(window: &WebviewWindow) -> Option<Screen> {
    let m = window.current_monitor().ok()??;
    Some(Screen::new(window, &m))
}
