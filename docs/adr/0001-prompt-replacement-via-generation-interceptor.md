# Compactions replace message text via a generation interceptor, never in storage

Compacted text must reach the model in place of the original message. We register a
`generate_interceptor` in `manifest.json` and swap `chat[i].mes` at prompt-build time;
the persisted `message.mes` is never touched and the compaction lives in
`message.extra.msgcompact`. The interceptor receives cloned message objects
(`public/script.js:4515` in SillyTavern 1.18.0) and runs before prompt assembly for
both Chat Completion and Text Completion, so one code path covers every backend and
uninstalling the extension can never corrupt a chat.

## Considered Options

- **Overwrite `message.mes`, keep original in `extra`**: destructive; fights ST's
  edit/swipe/regex machinery and leaves chats mangled if the extension is removed.
- **qvink-style hide + inject** (`is_system` + `setExtensionPrompt`): built for
  summaries living outside the message flow; breaks the 1:1 turn structure this
  extension exists to preserve.
- **`CHAT_COMPLETION_PROMPT_READY` event**: Chat Completion only; Text Completion
  would need a second divergent hook.

## Consequences

- For reasoning models, the merged reasoning prefix in the prompt copy is dropped when
  a message is replaced (acceptable: the feature exists to shed tokens).
- On `continue`-type generations the last message is never replaced, or the model
  would continue from text that differs from what ST appends to.
- Stale compactions (hash mismatch with the original) are skipped at interception
  time, so an edited original always wins over an outdated rewrite.
