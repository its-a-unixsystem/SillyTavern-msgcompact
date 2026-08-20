# Message Compact

A SillyTavern extension that lets the user shrink individual chat messages: the LLM
rewrites one message to use fewer tokens, and that rewrite replaces the original in
outgoing prompts while the original stays untouched in the chat.

## Language

**Compact** (verb):
Ask the LLM to rewrite one message with fewer tokens while preserving every event,
action, and piece of dialogue.
_Avoid_: compress, summarize, condense

**Compaction**:
The stored rewrite attached to a single message. Always 1:1 with its Original — never
a digest of multiple messages.
_Avoid_: summary, memory (both are qvink concepts with different semantics)

**Original**:
The message text as authored by the user or character. Never modified by this
extension.

**Active / Inactive**:
Whether a Compaction is substituted for its Original in the outgoing prompt. Toggling
is non-destructive; an Inactive Compaction is kept but unused.

**Stale**:
A Compaction whose Original was edited after it was created (detected by content
hash). A Stale Compaction is never sent to the model and is flagged in the UI until
re-run or deleted.
