# Build Plan

## Phase 1

- Scaffold a Vite React app with a local Node API
- Support a configurable Notes root path from the UI
- Index Markdown files under the Notes root and expose dashboard data
- Wire Copilot SDK sessions to custom notes tools for search, read, write, append, and project listing

## Phase 2

- Add structured note operations for common workflows such as rescheduling tasks, moving items between `INBOX.md` and `TODAY.md`, and project status rollups
- Add richer note chunking and citations so responses can show exact supporting files more cleanly
- Add guarded write operations with semantic transforms instead of whole-file replacements for common edits

## Phase 3

- Add optional local embeddings for retrieval quality on larger note sets
- Swap the current lexical ranking for hybrid search
- Add session history, saved prompts, and project-specific views in the UI

## Vector approach

Start with the current lightweight local index, then add vectors only when retrieval quality justifies the extra moving parts.

Recommended progression:

1. Keep lexical retrieval as the baseline.
2. Add chunk-level embeddings.
3. Store vectors locally in either `sqlite-vec` or LanceDB.
4. Continue using Copilot SDK for reasoning and tool orchestration, not as the storage layer.
