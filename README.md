# SillyTavern Message Compact

Shrink individual chat messages. A small compress icon on every message asks the LLM
to rewrite that message with fewer tokens while preserving every event, action, and
piece of dialogue. The compaction is shown in green below the original, the original
grays out, and future prompts send the compaction instead — the original text is never
modified and can be restored with one click.

## Usage

- Click the ⤢ icon in a message's button row to compact it.
- Click again to toggle between sending the compaction (green icon) and the original.
- On the green block: ↻ re-runs the compaction, ✎ edits it in place, 🗑 deletes it.
- Editing the original message marks its compaction **stale** (orange): it is kept but
  not sent to the model until you re-run it.

## Settings

Extensions panel → *Message Compact*:

- **Compaction prompt** — the instruction sent with `{{message}}`; tune it freely,
  standard ST macros work.
- **Connection profile** — run compaction requests on a different (e.g. cheaper)
  connection; default is the current one.
- **Max response tokens** — 0 uses the API default. Leave headroom for thinking
  models: their reasoning counts against the output budget.
- Display toggles for token stats and graying the original.

## Install

Extensions → Install extension → paste this repository's URL. Requires SillyTavern
1.13.0+.

## Design

See [docs/DESIGN.md](docs/DESIGN.md), [CONTEXT.md](CONTEXT.md), and
[docs/adr/](docs/adr/) for the product definition and architecture decisions.
