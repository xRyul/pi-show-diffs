# pi-show-diffs

A **pi** package that adds a diff approval flow before file changes are applied.

## What it does

`pi-show-diffs` intercepts file-changing tools and opens a review modal before the change runs.

It currently reviews:

- `edit`
- `hashline_edit`
- `write`

This gives **pi** an interactive pre-apply diff review step, so you can inspect the proposed change first and then decide whether to allow it.

## Diff review UX

For normal file changes, the modal uses a split diff viewer with:

- side-by-side **Original** / **Updated** columns
- syntax-aware ANSI highlighting for common code file types
- collapsed unchanged regions with clear labels
- hunk-aware navigation
- unified diff fallback for narrow terminals or preview errors
- live toggle between split and unified views
- inline editing for `edit` and `write` directly inside the diff modal
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

- `/diff-approval` — open or toggle approval settings
- `/show-diffs` — alias for `/diff-approval`

Command args:

- `/diff-approval on`
- `/diff-approval off`
- `/diff-approval toggle`
- `/diff-approval status`

## Keys in the diff modal

### Approval actions

- `Enter`, `a`, or `y` — approve
- `r` or `Esc` — reject
- `E` or `e` — enter inline edit mode for the updated side
- `Esc` in inline edit mode — leave editing and return to review mode
- `s` — steer and add feedback
- `Shift+A` — approve and turn on auto-approve

### Navigation

- `↑` / `↓` — scroll
- `PgUp` / `PgDn` — jump by page
- `Home` / `End` — jump to top/bottom
- `n` / `p` — next / previous hunk

### View controls

- `Tab` — toggle split / unified view
- `←` / `→` — decrease / increase shown context around hunks
- `[` / `]` — alternate context controls
- `w` — toggle wrapping

## Config

Persistent config is stored at:

`~/.pi/agent/extensions/pi-show-diffs.json`

Current config shape:

```json
{
  "autoApprove": false
}
```

## Notes

- no `edit`/`write` tool overrides are registered, so it stays compatible with other tool-wrapping extensions like `collapse-tools.ts`
- non-interactive mode falls back to a text-based diff review flow
- steering rejects the current proposal and sends your feedback back to the model
- editing final file content blocks the current tool call and asks pi to re-issue the exact revised change
- auto-approve restores normal behavior until you turn it off again
