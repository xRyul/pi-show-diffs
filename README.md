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

- `/diff-approval` — open or toggle approval settings
- `/show-diffs` — alias for `/diff-approval`

Command args:

- `/diff-approval on`
- `/diff-approval off`
- `/diff-approval toggle`
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
- editing final file content applies immediately for `edit`, `write`, and `hashline_edit` after the original tool call succeeds
- auto-approve restores normal behavior until you turn it off again
- invalid `hashline_edit` previews (for example tag mismatches) skip the review modal and fall through to the tool's normal error handling
