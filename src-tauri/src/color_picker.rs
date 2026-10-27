//! System colour picker: places the native dialog next to the pointer.

/// Called just before a page opens the system colour picker (chrome.js,
/// `MemoColorPicker`).
#[tauri::command]
pub(crate) fn place_color_picker() {
    place_color_dialog();
}

/// Moves the system colour dialog next to the mouse pointer (the swatch just
/// clicked). Windows opens it where the WebView2 browser process sees fit,
/// often far from the window that asked; the dialog belongs to that process,
/// so it is found by its owner: one of Memo's windows. Elsewhere the system
/// places its picker itself (GTK dialog, NSColorPanel), so nothing to do.
#[cfg(windows)]
pub(crate) fn place_color_dialog() {
    use std::{thread, time::Duration};
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, POINT, RECT},
        Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        System::Threading::GetCurrentProcessId,
        UI::WindowsAndMessaging::{
            EnumWindows, GetAncestor, GetClassNameW, GetCursorPos, GetWindow, GetWindowRect,
            GetWindowThreadProcessId, IsWindowVisible, SetWindowPos, GA_ROOT, GW_OWNER,
            SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
        },
    };

    // A visible "#32770" (dialog class) window owned by one of ours.
    unsafe extern "system" fn find(hwnd: HWND, found: LPARAM) -> i32 {
        // SAFETY: plain Win32 queries; `found` points at the caller's HWND.
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let mut class = [0u16; 16];
            let len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
            if String::from_utf16_lossy(&class[..len.max(0) as usize]) != "#32770" {
                return 1;
            }
            let owner = GetAncestor(GetWindow(hwnd, GW_OWNER), GA_ROOT);
            let mut pid = 0;
            GetWindowThreadProcessId(owner, &mut pid);
            if owner.is_null() || pid != GetCurrentProcessId() {
                return 1;
            }
            *(found as *mut HWND) = hwnd;
            0
        }
    }

    let mut cursor = POINT { x: 0, y: 0 };
    // SAFETY: writes into the local POINT.
    if unsafe { GetCursorPos(&mut cursor) } == 0 {
        return;
    }
    thread::spawn(move || {
        // The dialog shows up a moment after the click: look for it for 2 s.
        for _ in 0..80 {
            thread::sleep(Duration::from_millis(25));
            let mut dialog: HWND = std::ptr::null_mut();
            // SAFETY: `find` only writes the HWND it was given.
            unsafe { EnumWindows(Some(find), &mut dialog as *mut HWND as LPARAM) };
            if dialog.is_null() {
                continue;
            }
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            // SAFETY: plain Win32 calls on locals; a failed one leaves the
            // dialog where it is.
            unsafe {
                if GetWindowRect(dialog, &mut rect) == 0
                    || GetMonitorInfoW(
                        MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST),
                        &mut info,
                    ) == 0
                {
                    return;
                }
                // Below and to the right of the pointer, kept on its monitor.
                let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
                let area = info.rcWork;
                let x = (cursor.x - 16).min(area.right - w).max(area.left);
                let y = if cursor.y + 16 + h <= area.bottom {
                    cursor.y + 16
                } else {
                    cursor.y - 16 - h
                };
                let y = y.min(area.bottom - h).max(area.top);
                SetWindowPos(
                    dialog,
                    std::ptr::null_mut(),
                    x,
                    y,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            return;
        }
    });
}

#[cfg(not(windows))]
pub(crate) fn place_color_dialog() {}
