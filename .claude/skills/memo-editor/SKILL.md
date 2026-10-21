---
name: memo-editor
description: The Memo note editor in app.js/index.html/styles.css. Use when changing note content handling — the stored HTML format, sanitize/toPlain/fromPlain, checklists and bullets, text size and highlight, inline code and code blocks with Prism, undo/redo, the format bar, paste, shortcuts, the titlebar of a note, or the embedded defaults editor.
---

# Note editor (`app.js`)

`app.js` is a single IIFE (~1.6k lines); find sections with `memo-code-map`. Text saves are debounced 250 ms and flushed on blur / window blur / beforeunload; `save_text(text, html)` stores both. Pin toggling is optimistic and reverts on error.

## Note window chrome

Titlebar: pin far left, colour dot (`#colorBtn` → swatch popover `#colorMenu`), name, then new / close on the right (always visible). Drag, resize, middle-click close (`auxclick` → `closeNote`, same as ✕) and double-click rename (inline `#titleInput` → `set_title`, max 80 chars) come through `MemoChrome.attach` (`chrome.js`); resize handles and the bottom-right grip are `chrome.js` too. The name (or first line) is mirrored to the native window title (`setTitle`). Footer: `#footBtn` shows the group (see `memo-groups`). The native context menu is suppressed everywhere except the editor and the title input. Shortcuts: Mod+Shift+P pin, Mod+N new note (Mod = ⌘ on Mac, Ctrl elsewhere).

## Stored format

`#editor` is a `contenteditable` div; each line is a `<div>`. The note stores `html` (the editor's `innerHTML`, re-sanitised on load by `sanitize` to this whitelist) and `text` (plain text via `toPlain`). Rust only reads `text` (`is_blank`); a note with empty `html` is rebuilt from `text` (`fromPlain`). Paste is always plain text.

- Bold/italic/underline: `<b>`/`<i>`/`<u>` (`styleWithCSS` off). Bold must render at weight ≥ 600 or `queryCommandState('bold')` (and Ctrl+B toggling off) breaks.
- Highlight: `<span style="background-color: rgb(255, 230, 0)">` from `execCommand('hiliteColor')` — only that exact sentinel counts (Chromium creates other background spans). WebKit (macOS/Linux) puts the style on the `<b>`/`<i>`/`<u>`/`<font>` itself when the selection is exactly that element, so `sanitize` keeps the sentinel on those too and the CSS rule matches any element; removal sets `transparent`. Mod+Shift+H or the marker button.
- Text size: `<font size="2|3|5">` from `execCommand('fontSize')` (`SIZES` in app.js; real px in the `.editor font[size]` CSS rules — keep both in sync). Mod+Shift+> / Mod+Shift+< (matched by `e.code` Period/Comma).
- Checklist item: `<div class="check">` (checked: `check done`, box drawn in CSS `::before`). Bullet: `<div class="bullet">`. Both can carry `data-level` 1–4.
- Inline code: `<code>`. Code block: `<pre class="code" data-lang>` holding only text and `<br>`.
- Plain text: items are `[ ] ` / `[x] ` (`[]` also accepted by `LIST_RE`/`plain`), bullets `- `, each level two leading spaces (`listPrefix`, `LIST_RE`); inline code `` `x` ``, code blocks ```` ```lang … ``` ```` fences (`fromPlain` parses both); U+200B is stripped.
- Presentation-only attributes (dropped by `sanitize`, recomputed): `syncCheckSizes` (on load and every change) gives an item whose text is all one `<font size>` a `data-size` so the line takes that size; mixed-size items get an inline `--check-mid` with the measured first-line centre.

## Lists

Typing `[]` at line start makes a checklist item; `- ` makes a bullet (`expandBullet`); a space typed right after is dropped. Clicking the box toggles it without moving the caret. Enter continues the list (the browser clones the block; `done` is cleared). Tab / Shift+Tab change level (`setLevel`). Enter on an empty item or Backspace at its start outdents first, then leaves the list.

## Code

- Inline: typing `` `x` `` → `expandInlineCode`, or Mod+E / `</>` → `toggleCode`. Dead-key backticks (ABNT2, US-International) are covered too: the closing backtick may arrive with the next character (`insertText` "`,", kept after the code) or as a composition (`compositionend` handler). Inserted straight into the DOM with a trailing U+200B so the caret leaves the code (Chromium's `insertHTML` would copy inline styles).
- Block: ```` ```lang ```` + Enter → `openCodeBlock`. Inside: Enter = line break, Tab = two spaces, Enter on an empty last line leaves; list/inline conversions are disabled. `preText` reads it (Range.toString ignores `<br>`). `codeLang` normalises `data-lang` (aliases `js`/`py`/`sh` → `CODE_LANGS` values; unknown names kept as typed).
- Highlighting is presentation only: the pre's own text is `color: transparent`, and `renderCode` (on every content change, scroll, resize and language change) lays one item per block in `#codeLayer` (a sibling of the editor inside `.body`, never saved) with Prism's highlighted copy (`src/vendor/prism.js`: vendored core + 20 languages, `data-manual` — don't read it) mirroring the block's computed font/padding/wrapping. The block's top padding is a header row, so the `<select class="code-lang">` (top-left, `setCodeLang`; always shown as a quiet label, a button while hovered) and the copy button (`.code-copy`, top-right, only while hovered → `copyCode`: `preText` to the clipboard via a synchronous `copy` event so the editor keeps focus, `navigator.clipboard` fallback; a check for 1.5 s). Token CSS (`--code-*` in base.css, both themes) uses colours only — bold/italic would change glyph widths and misalign the copy.

## Undo

The editor keeps its own history ("undo" section): many edits change the DOM directly, which Chromium's undo stack never sees. `onContentChanged(typing)` records a snapshot (HTML + selection as child-index paths) after every change (`recordHistory`; typing within `TYPING_MS` merges into one step, a paste never does); `selectionchange` keeps the current step's caret up to date; Mod+Z, Mod+Shift+Z / Mod+Y and `beforeinput` historyUndo/historyRedo call `restoreHistory`. Auto-conversions (`` `x` ``, `[]`, `- `) record the typed text first, so undo brings the characters back; their internal execCommand edits are ignored by the `converting` guard. **Any new DOM-changing edit must end in `onContentChanged()`.**

## Format bar

`#formatBar` (bold / italic / underline, highlight, code `</>` and three "A" size buttons) floats above a non-empty selection; hidden while the mouse drags a selection, repositioned on `selectionchange`/scroll/resize; buttons use `mousedown` preventDefault so the selection survives; active state from `queryCommandState`. Right-click keeps the native menu (spellcheck, cut/copy/paste) inside the editor.

## Embedded editor

`index.html?defaults` runs the same page in embedded mode (`EMBED` in app.js, `html.embedded` in styles.css: no titlebar, statusbar, colour stripe or window shortcuts; Tauri API taken from `window.parent` inside an iframe). The manager's settings use it in `<iframe id="defaultTextFrame">` to edit the new-note default text: it loads `get_new_note_defaults` → `(title, text, html)` and saves with `set_default_content(text, html)`; the title is saved separately (`set_default_title`). `Store::create` copies `default_title`/`default_text`/`default_html` into new notes.

Changing the editor's HTML whitelist? Also check `welcome.rs` (its HTML must survive `sanitize` and its `TEXT` must equal `toPlain` of that HTML) and the Help demos (`memo-manager`).
