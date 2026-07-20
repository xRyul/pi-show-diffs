# pi-show-diffs

warp.dev inspired **pi** extension that stops and shows an editable diff before file changes are applied.

https://github.com/user-attachments/assets/8bda7619-fcd2-4615-a93a-d15b2fee408b

It currently reviews:

- `edit`
- `hashline_edit`
- `write`

This gives **pi** an interactive pre-apply diff review step, so you can inspect the proposed change first and then decide whether to allow it.

## Diff review UX

For normal file changes, the modal uses a split diff viewer with:

- side-by-side **Original** / **Updated** columns
- syntax-aware ANSI highlighting for common code file types
- vibrant intraline highlights so changed words or characters stand out inside changed lines
- optional colored rail markers beside rendered diff lines
- collapsed unchanged regions with clear labels
- hunk-aware navigation
- unified diff fallback for narrow terminals or preview errors
- live toggle between split and unified views
- inline editing for `edit`, `write`, and valid `hashline_edit` previews directly inside the diff modal
- adjustable context expansion around hunks
- wrapped inline rendering for long lines

## Install

Install from npm:

```bash
pi install npm:pi-show-diffs
```

Or install directly from GitHub:

```bash
pi install git:github.com/xRyul/pi-show-diffs
```

## Commands

- `/diff-approval` — open approval settings; use `↑`/`↓` to select a setting and `Space`/`Enter` to cycle its value. The Keybindings row opens the keybinding editor.
- `/show-diffs` — alias for `/diff-approval`

Command args:

- `/diff-approval on`
- `/diff-approval off`
- `/diff-approval toggle`
- `/diff-approval colors default` — use built-in diff backgrounds (`dark` uses the original muted red/green; `light` uses light-friendly red/green)
- `/diff-approval colors theme` — use the active pi theme's tool success/error backgrounds
- `/diff-approval keybindings` — open the keybinding editor directly
- `/diff-approval status`

## Shortcuts in the diff modal

### Approval actions

- `Enter`, `a`, or `y` - approve
- `r` or `Esc` - reject
- `E` or `e` - enter inline edit mode for the updated side
- `Esc` in inline edit mode — leave editing and return to review mode
- `s` - steer and add feedback
- `Shift+A` - approve and turn on auto-approve

### Navigation

- `↑` / `↓` - scroll
- `PgUp` / `PgDn` - jump by page
- `Home` / `End` — jump to top/bottom
- `n` / `p` - next / previous hunk
- inline edit mode: `Ctrl+N` / `Ctrl+P` jump hunks; `Alt`/`Option` + `↑` / `↓` also works if your terminal is configured to send Alt

### View controls

- `Tab` - toggle split / unified view
- `←` / `→` — decrease / increase shown context around hunks
- `[` / `]` - alternate context controls
- `w` - toggle wrapping
- `Ctrl+F` - when expandable layout is enabled, open/collapse the expanded overlay

## Config

Persistent config is stored at:

`~/.pi/agent/extensions/pi-show-diffs.json`

Current config shape:

```json
{
  "autoApprove": false,
  "diffColorMode": "default",
  "showDiffRail": true,
  "expandableLayout": false,
  "collapsedHeight": "30%",
  "expandedHeight": "100%",
  "expandedWidth": "100%",
  "pathStyle": "full",
  "pathSegments": 3,
  "keybindings": {
    "approve": ["Enter", "a", "y"],
    "reject": ["Escape", "r"]
  }
}
```

`diffColorMode` accepts:

- `default` — use pi-show-diffs predefined diff backgrounds. Dark themes use the original muted red/green; light themes use light-friendly red/green.
- `theme` — follow your active pi theme's tool success/error backgrounds.

Diff marker options:

- `showDiffRail` — when `true`, show a colored `▌` rail marker next to rendered diff lines.

Expandable layout options:

- `expandableLayout` — when `true`, render the diff inline first instead of as a centered overlay.
- `collapsedHeight` — inline diff height as a percentage string, clamped to `10%`-`100%`.
- `expandedHeight` — maximum overlay height after `Ctrl+F`, clamped to `10%`-`100%`.
- `expandedWidth` — overlay width after `Ctrl+F`, clamped to `10%`-`100%`.

Path display options:

- `pathStyle` — `"full"` (default) shows the entire path in the diff header; `"short"` keeps only the last few segments with a leading `…/`, for example `…/components/ui/button.tsx`.
- `pathSegments` — how many trailing segments the short form keeps (default `3`); paths with that many segments or fewer are shown unchanged.

Keybindings are configured per action. Use comma-separated pi-tui key ids such as `Enter`, `Escape`, `ctrl+f`, `pageUp`, or `up`; set an action to `false` to disable it. Missing actions fall back to defaults.

## Notes

- no `edit`/`write` tool overrides are registered, so it stays compatible with other tool-wrapping extensions like `collapse-tools.ts`
- non-interactive mode falls back to a text-based diff review flow
- steering rejects the current proposal and sends your feedback back to the model
- editing final file content applies immediately for `edit`, `write`, and `hashline_edit` after the original tool call succeeds
- auto-approve restores normal behavior until you turn it off again
- invalid `hashline_edit` previews (for example tag mismatches) skip the review modal and fall through to the tool's normal error handling
