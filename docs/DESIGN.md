# SillyTavern-msgcompact — Design & Product Definition

## 1. Product definition

### What it is
A lightweight SillyTavern UI extension that lets the user compact individual chat
messages: one click on a per-message icon sends that message's text to the LLM with a
configurable "reduce token usage, keep all events" prompt, and stores the compacted
version alongside the original. The compacted text is what gets sent to the model in
future prompts; the original stays in the chat, grayed out but readable, and can be
restored at any time.

Think "qvink memory, minus the memory system": no summaries injected elsewhere in the
context, no auto-summarization pipeline, no injection thresholds. Each message is
simply replaced, in place, by a shorter version of itself at prompt-build time.

### Why (problem statement)
Long roleplay messages burn context. Summarization extensions (qvink) solve this by
replacing *ranges* of history with a summary block, which loses the turn structure and
voice of individual messages. msgcompact keeps the chat structure 1:1 — same number of
messages, same roles, same order — but each compacted message costs fewer tokens.

### Core user stories (v1)
1. As a user, I see a small compress icon in the button row of every message.
2. Clicking it compacts that message via the LLM using my configured prompt; while it
   runs I see a spinner.
3. When done, the compacted text appears attached to the message in green, the
   original text grays out, and the icon changes to the "compacted" state.
4. Clicking the icon on a compacted message toggles the compaction off/on
   (original ungreys / greys; prompt uses original / compacted).
5. Small controls on the compacted block let me re-run, edit, or delete the compaction.
6. In the extension settings I can edit the compaction prompt (with a
   `{{message}}` placeholder) and reset it to the default.
7. Everything persists with the chat: reload, switch chats, branches — state survives.

### Non-goals (v1)
- No automatic compaction (by age, by token threshold, on message received).
- No batch "compact all" (candidate for v1.1 as a slash command).
- No compaction of hidden/system messages.
- No cross-message summarization — strictly 1 message → 1 compacted message.

## 2. UX specification

### Per-message button
Injected into each message's `.mes_buttons` row (visible directly, not inside the
"..." `extraMesButtons` drawer), for user and character messages alike; skipped for
`is_system` messages.

| State | Icon (FontAwesome, bundled with ST) | Color | Click action |
|---|---|---|---|
| none | `fa-down-left-and-up-right-to-center` | default dim | run compaction |
| running | `fa-spinner fa-spin` | default | no-op (guarded) |
| active | same icon, `.mc_active` | green (theme quote color) | deactivate → `inactive` |
| inactive | same icon, `.mc_inactive` | dim/strikethrough tint | reactivate → `active` |
| stale (message edited after compaction) | same icon, `.mc_stale` | orange/warning | re-run compaction |

### Compacted block
Rendered directly below the message's `.mes_text`:

```
┌ .mes_text  (original — opacity ~0.4 when compaction active) ┐
└──────────────────────────────────────────────────────────────┘
┌ .mc_block ──────────────────────────────────────────────────┐
│ ⤢ compacted · 1234 → 410 tokens (−67%)      [↻] [✎] [🗑]    │
│ <compacted text, green, slightly smaller>                    │
└──────────────────────────────────────────────────────────────┘
```

- Green text (reuse the theme's quote/success color via CSS variable, fallback
  `#66bb6a`), small header line with token stats (setting-toggleable).
- `[↻]` re-run, `[✎]` edit in place (swap the block for a textarea, save on blur/Enter),
  `[🗑]` delete compaction entirely (restores normal styling and icon).
- When compaction is toggled **inactive**: original text returns to full opacity,
  `.mc_block` itself drops to low opacity — the visual state always mirrors what the
  prompt will contain.
- Stale state: block gets an orange left border + "original was edited" note.

### Settings panel
Standard extension drawer in Extensions → "Message Compact":
- **Compaction prompt** — textarea, `{{message}}` macro (substituted via
  `substituteParamsExtended`, so all standard ST macros also work). "Restore default"
  button.
- **Connection profile** — run compaction requests on a different Connection Manager
  profile (e.g. a cheap/local model); empty = current connection. Sent via
  `ConnectionManagerRequestService.sendRequest` (`public/scripts/extensions/shared.js:392`).
- **Max response tokens** — number, 0 = use the API/preset default. Deliberately no
  size-derived cap: thinking models (e.g. Gemini 2.5) spend `maxOutputTokens` on
  reasoning first, so a tight cap truncates the response before any content appears.
- **Show token stats** checkbox (default on).
- **Gray out original** checkbox (default on).

### Default prompt (user-tunable)
```
Rewrite the following roleplay message to use as few tokens as possible.
Preserve every event, action, and piece of dialogue and their order. Keep all
names, facts, and numbers exactly. Condense wording only — do not summarize
away or reinterpret anything, do not add commentary or notes.
Output only the rewritten message, nothing else.

Message:
{{message}}
```

## 3. Architecture

### The one decision that matters: how the compacted text enters the prompt

**Chosen: a generation interceptor (`generate_interceptor` in `manifest.json`).**
`message.mes` is never touched; the compacted text lives in `message.extra` and is
swapped in only at prompt-build time.

Verified against the current ST codebase:
- `runGenerationInterceptors(coreChat, this_max_context, type)` is awaited inside
  `Generate()` (`public/script.js:4538`) **before** prompt assembly, for both Chat
  Completion and Text Completion APIs — so one code path covers every backend.
- `coreChat` entries are already fresh clones of the persisted messages
  (`public/script.js:4515` builds `{...chat[i], mes: ...}` objects), so mutating
  `chat[i].mes` inside the interceptor only affects the outgoing prompt, never the
  saved chat.
- The interceptor is registered by name: manifest field `generate_interceptor`
  → `globalThis[thatName](chat, contextSize, abort, type)`
  (`public/scripts/extensions.js:2033`).

Why not the alternatives:
- *Overwrite `message.mes`, keep original in `extra`*: destructive; fights with ST's
  own edit/swipe/regex machinery, breaks search, and corrupts the chat if the
  extension is ever removed mid-state.
- *`CHAT_COMPLETION_PROMPT_READY` event*: Chat Completion only; Text Completion would
  need a second, messier hook.
- *qvink's hide-and-inject (`is_system` + `setExtensionPrompt`)*: designed for
  summaries living outside the message flow; wrong shape for 1:1 replacement.

### Data model

Per-message state, persisted automatically with the chat (`message.extra` is saved in
the chat `.jsonl`, and is per-swipe via `swipe_info`, so each swipe carries its own
compaction):

```js
message.extra.msgcompact = {
    text: string,          // the compacted message
    active: boolean,       // toggled by the icon
    hash: number,          // getStringHash(message.mes) at compaction time → stale detection
    tokens_before: number,
    tokens_after: number,
    created: number,       // Date.now()
}
```

Settings, persisted in `extension_settings.msgcompact` via `saveSettingsDebounced()`:

```js
{
    prompt: DEFAULT_PROMPT,
    responseLength: 0,
    showTokens: true,
    grayOriginal: true,
}
```

After any write to `message.extra`, call `context.saveChat()` (debounced wrapper).

### File layout

```
manifest.json      # display_name, js: index.js, css: style.css,
                   # generate_interceptor: "msgcompact_interceptor"
index.js           # entry: settings load, event wiring, interceptor, delegated clicks
settings.html      # settings drawer markup (loaded via renderExtensionTemplateAsync)
style.css          # .mc_block, .mc_active/.mc_inactive/.mc_stale, gray-out rules
README.md
```

Single-module `index.js` is fine at this size (~300–400 lines); split into
`src/` modules only if v1.1 features land.

### Module responsibilities (inside index.js)

**Interceptor** — the whole prompt-side feature is ~10 lines:
```js
globalThis.msgcompact_interceptor = async function (chat, _ctxSize, _abort, type) {
    if (type === 'quiet') return; // don't alter background/utility prompts
    for (const msg of chat) {
        const mc = msg.extra?.msgcompact;
        if (mc?.active && mc.hash === getStringHash(msg.mes)) {
            msg.mes = mc.text;
        }
    }
};
```
(Stale compactions are silently skipped for the prompt and flagged in the UI.)

**Compactor** — builds the prompt from the template with
`substituteParamsExtended(settings.prompt, { message: msg.mes })` and calls
`context.generateRaw({ prompt, ...(settings.responseLength ? { responseLength: settings.responseLength } : {}) })`.
`generateRaw` sends a standalone request on the current API without chat history —
exactly what's needed. Token counts via `getTokenCountAsync`. Single-flight guard:
one compaction at a time; button click while `running` is ignored.

**UI layer** —
- Button + block injection driven by events (below); rendering reads only from
  `message.extra` (idempotent `renderMessage(mesId)` that can always rebuild a
  message's decorations from state).
- One **delegated** click handler on `#chat` for `.mc_button`, `.mc_rerun`,
  `.mc_edit`, `.mc_delete` — survives ST re-rendering message DOM nodes.

**Event wiring** (names verified in `public/scripts/events.js`):

| Event | Handler |
|---|---|
| `APP_READY` | init settings UI, full render sweep |
| `CHAT_CHANGED` | full render sweep over visible messages |
| `USER_MESSAGE_RENDERED`, `CHARACTER_MESSAGE_RENDERED` | `renderMessage(mesId)` |
| `MESSAGE_EDITED` | recompute hash match → mark stale if changed, re-render |
| `MESSAGE_SWIPED` | re-render (extra travels with `swipe_info`; new swipes start clean) |
| `MESSAGE_DELETED` | nothing to clean (state lives on the message) — re-render sweep |

### Edge cases & rules
- **Reasoning models**: `coreChat[i].mes` handed to the interceptor may already have
  reasoning merged in; replacing it drops the reasoning from the prompt for that
  message. Acceptable — compaction exists to shed tokens. Documented behavior.
- **Compacting while a generation streams**: refuse with a toast
  (`toastr.warning`) if ST is mid-generation.
- **Empty/short messages**: button always shown, but compactor refuses messages under
  ~30 tokens with a toast ("nothing to gain").
- **LLM returns garbage/empty**: empty or whitespace-only result → error toast, no
  state written. Result *longer* than original (by token count) → warning toast, still
  stored (user can delete) — the user is fine-tuning prompts and needs to see failures.
- **Extension uninstalled**: chats remain fully valid — originals were never modified;
  leftover `extra.msgcompact` blobs are inert.
- **Group chats**: no special handling needed; interceptor and per-message extra work
  identically.

## 4. Roadmap after v1

1. **v1.1** — `/compact <mesId|range>` slash command; "compact all messages older
   than N" bulk action.
2. **v1.2** — auto-compact policy (age- or context-pressure-triggered), aggregate
   savings display ("this chat: −38%… tokens"), per-character prompt overrides.

## 5. Settled decisions (grill session, 2026-08-20)
- Vocabulary: verb **compact**, artifact **compaction** (see `CONTEXT.md`).
- Prompt mechanism: **generation interceptor** (ADR 0001).
- Button in the always-visible `.mes_buttons` row (qvink hides its buttons in the
  "..." drawer; we deliberately don't).
- Icon click on an existing compaction **toggles** active/inactive; delete is an
  explicit 🗑 on the block; stale click re-runs.
- **Connection profile support ships in v1** (dropdown, empty = current connection).
- Single prompt template with `{{message}}` + standard macros; no separate system
  prompt field.
- Edited original ⇒ compaction marked stale and **skipped** in the prompt until
  re-run.
- Both user and character messages, greeting included, system/hidden skipped,
  refuse under 30 tokens.
- No batch operations in v1.
