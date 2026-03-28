# pi-show-diffs

A **pi** package that gives you a **Warp.dev-style diff approval flow** before file changes are applied.

- GitHub: https://github.com/xRyul/pi-show-diffs
- npm: https://www.npmjs.com/package/pi-show-diffs

## What it does

`pi-show-diffs` intercepts file-changing tools and opens a review modal before the change runs.

It currently reviews:

- `edit`
- `hashline_edit`
- `write`

That makes **pi** feel closer to the change preview flow people like in **Warp / Warp.dev**: you can inspect the proposed diff first, then decide whether to allow it.

## Diff review UX

For normal file changes, the modal uses a split diff viewer with:

- side-by-side **Original** / **Updated** columns
- syntax-aware ANSI highlighting for common code file types
- collapsed unchanged regions with clear labels
- hunk-aware navigation
- unified diff fallback for narrow terminals or preview errors
- live toggle between split and unified views
- adjustable context expansion around hunks
- wrapped inline rendering for long lines

## Install

### From npm

```bash
pi install npm:pi-show-diffs
```

### From GitHub

```bash
pi install git:github.com/xRyul/pi-show-diffs
```

### Local dev install

```bash
ln -s /Users/daniel/Developer/Projects/pi-show-diffs ~/.pi/agent/extensions/pi-show-diffs
```

Then inside **pi** run:

```text
/reload
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

- non-interactive mode falls back to a text-based diff review flow
- steering rejects the current proposal and sends your feedback back to the model
- auto-approve restores normal behavior until you turn it off again
