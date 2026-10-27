---
name: memo-groups
description: Memo's groups of memories (group bars). Use when changing group.html/group.js, groups.rs, Note.group_id, taking notes out / putting them away, joining or leaving a group, or group trash.
---

# Groups

Code: `src-tauri/src/groups.rs`, `src/group.html` / `group.js` / `group.css`, the footer picker (`src/components/group-picker.js`, `GroupPicker`, used by `app.js` section "groups" and by boards), the Grupos tab in `manager.js`.

**Model.** `Group` (`FileData.groups`): id, name, outer x/y, logical width, `open`, `pinned`, `color`, `hidden`, `trashed_at`. Notes point to it with `Note.group_id`; `normalize` clears links to missing groups. Windows, `visible()`, the pickers and export only use `active_groups()`.

**Bar window.** Label `group-{id}`, built by `open_group_window`, height `TITLEBAR_H × zoom`. Same titlebar as a note: its own pin (`Group.pinned`, through the shared `set_pinned`, Mod+Shift+P), colour (same labels; picked by clicking the folder icon `#colorBtn`, drawn in the group's colour, → `set_group_color`; while the picker is open the window grows with `set_group_height`, not saved, and shrinks back). Only e/w resize handles (`MemoChrome.attach({ resizeEdges })`), no Snap. The group colour also tints the note footer's folder, a 2px top stripe and soft wash over a member note's titlebar (`#groupTint`, set in `renderMeta`) and the same top stripe and wash over the bar itself (`group.css`) and the manager's group chip.

**Names.** Groups start unnamed (`Store::create_group` applies the new-group defaults — colour and title, empty by default; `rename_group` accepts an empty one, max `GROUP_NAME_MAX`). An unnamed group reads "Sem título"/"Untitled" (`untitled`) on its bar, footer, picker and manager; its native window title is "Memo" (`group_title`). Double-click on the bar renames.

**Out / away.** The arrow button (`#toggleBtn`; up = put away, down = take out) → `toggle_group`. `take_out` builds the members' windows hidden at their saved place, moves them to the bar and slides them there (`slide`, ~140 ms ease-out on a worker thread). `put_in` slides open members into the bar and destroys them. The `Sliding` set makes `track_geometry` ignore those moves so notes keep their places (cleared on `Destroyed`, or 150 ms after a slide-out). A single click on an open group's bar (not a drag, a button or a double-click's second click; `group.js`) → `show_group_notes` → `raise_group`: reopens members closed with ✕ (`take_out`), focuses every member and then the bar; the manager's `focus_group` ends in `raise_group` too. `open_note` on a note of a put-away group takes the whole group out; `restore_note` doesn't open a note whose group is put away.

**New note in a group.** `+` / Mod+N on a bar → `new_note_in_group`: a note created in the group beside the bar, taking a put-away group out first.

**Joining.** Drop a note on a bar (`drag_move` → `group_under`, broadcasting `drop-hover` `[groupId, on]`; `drag_end` → `join_group`, sliding back to the drag's start if the group is open, into the bar if put away), the footer picker (`#footBtn` → `#groupMenu` → `set_note_group`). The manager only shows a note's or board's group (a `.card-pill`), it doesn't change it. Both pickers go through `assign_group` (`""` = leave, `"new"` = `create_group`, placed with `beside`). The footer button always shows the note's group with a folder icon ("Sem grupo"/"No group" without one).

**Close.** ✕ / middle click → `close_group`: sets `Group.hidden` and destroys the bar and its notes' windows (a group nobody touched — `Store::is_pristine_group`: default or empty name, default colour, no notes — is removed outright, here and in `trash_group_by_id`; never-sent pristine groups are not uploaded). `focus_group` / `show_group` reopen it. The manager's new-group button → `new_group` (an empty group beside the manager).

**Trash.** Manager row trash → `trash_group_id`: sets `Group.trashed_at`, then members go through `trash()` (so their `trashedAt` is later); an empty unnamed group is removed outright. `restore_group` brings the group back with the notes trashed at/after it. `delete_group_forever` / `empty_group_trash` remove trashed groups (their notes stay in the trash, ungrouped). `restore_note` ungroups a note whose group is trashed.

**Events.** Changes emit `groups-changed`; group bars, note footers and the manager reload on it.

