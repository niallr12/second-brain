# Second Brain

Second Brain is a local AI assistant for a PARA-style notes workspace. It is designed to help a single user manage Markdown files such as `TODAY.md`, `WAITING.md`, `INBOX.md`, and project folders under `projects/`, using GitHub Copilot as the reasoning layer and a small local API as the control layer.

The intent is simple: instead of manually opening and editing note files, you ask the assistant questions such as:

- What do I need to work on today?
- What is the latest on a specific project?
- How do I raise a request for a new ALB?
- Move this item from waiting to today.
- Add an update to a project status note.
- Improve a rough internal email before sending it.

The application reads and updates the Notes workspace automatically, but it does so through constrained tools rather than unrestricted shell access.

## Security Model

The app is intentionally local-first:

- the backend binds to `127.0.0.1` only
- the API requires a local access key before it will return config, dashboard, actions, or chat
- note reads, indexing, search, and file writes stay on the local machine
- the PWA caches only the frontend shell, not `/api` responses

The important exception is chat:

- chat prompts go through GitHub Copilot
- the assistant can send selected local note excerpts and structured task/project data to Copilot in order to answer
- if your notes are highly sensitive, you should treat chat mode as a remote boundary

The app now runs Copilot in a restricted mode by default. It exposes search and structured note tools, but not arbitrary full-file read/write tools.

## Trusted Mode

There is also an explicit `Trusted mode` toggle in the workspace settings.

- default: off
- when off: chat is limited to search plus structured note/project tools
- when on: chat can also use full-file note tools such as `read_note`, `write_note`, and `append_note`

This is meant to keep the default safe without making the app feel crippled. Turn it on only when you intentionally want broader chat-driven note editing.

## Local Access Key

On first backend start, the app creates a local access key unless `SECOND_BRAIN_ACCESS_KEY` is already set.

- file-backed key location: `.second-brain/auth.json`
- environment override: `SECOND_BRAIN_ACCESS_KEY`

The frontend shows an unlock screen until you enter that key. This is intended to protect the local API from other processes or pages on the machine.

## Desktop Install

The frontend is now PWA-ready, so it can be installed as a desktop app from supported browsers such as Chrome or Edge.

For the install prompt to appear:

- serve the app from `localhost` or over HTTPS
- load the frontend in a supported browser
- use the built app, not just static files opened directly from disk

When the browser exposes installation, the UI shows an `Install App` button in the header.

## Platform Support

The app is intended to run on macOS, Linux, and Windows.

Runtime notes:

- the backend uses Node path utilities, so notes roots can be POSIX or Windows style
- a Windows notes path would typically look like `C:\\Users\\you\\Desktop\\Notes`
- the frontend and backend scripts are standard `npm` scripts, so setup should be the same across platforms
- the main external dependency to validate on a Windows work machine is GitHub Copilot CLI and SDK authentication

## What It Uses

### Frontend

- React 19
- Vite 8
- TypeScript
- Plain CSS

The frontend is a lightweight chat and dashboard UI. It lets the user:

- configure the Notes root path
- unlock the local API with an access key
- chat from a simple default screen
- inspect the current state of core notes
- browse project summaries
- run direct quick actions for capture, triage, completion, and project updates
- review recent changes made by the assistant or quick actions
- switch trusted mode on or off for broader chat access
- submit chat prompts to the backend
- improve rough email drafts on a separate route, optionally using the incoming email as context, without touching the Notes workspace

### Backend

- Node.js
- Express 5
- GitHub Copilot SDK
- Zod
- Chokidar
- gray-matter

The backend does the actual work:

- indexes Markdown files from the Notes workspace
- serves dashboard and configuration APIs
- exposes custom tools to the Copilot SDK
- exposes a separate email rewrite endpoint backed by Copilot but isolated from note tools
- performs safe scoped file writes inside the configured Notes root
- enforces loopback-only API access and local access-key authentication

### AI Layer

- GitHub Copilot SDK for session management and tool orchestration
- Restricted-by-default custom tools for search, task capture, task movement, task completion, task metadata updates, and project updates
- Optional trusted-mode tools for full-file note reads and writes

Copilot is used for reasoning and decision-making. The backend remains the source of truth for file access and note mutation.

## How It Works

### 1. Notes workspace indexing

At startup, the backend scans the configured Notes folder and builds an in-memory index of Markdown files.
After startup, changed files are refreshed incrementally rather than forcing a full rescan of the workspace.

It understands these conventions:

- `TODAY.md`
- `WAITING.md`
- `INBOX.md`
- `projects/<project-name>/**/*.md`

Each document is normalized into searchable metadata including:

- relative path
- title
- project association
- last modified timestamp
- tokenized text for lexical retrieval

The backend also splits notes into smaller chunks by heading and content block. Search runs against those chunks rather than whole files, which improves relevance and gives the assistant cleaner citations.

Filesystem watcher events are also debounced before indexing, so a burst of note edits does not immediately trigger repeated refresh work.

### 2. Dashboard API

The frontend calls the backend for a summary view of the workspace. That includes:

- the configured Notes path
- index statistics
- previews of `TODAY.md`, `WAITING.md`, and `INBOX.md`
- project summaries derived from files under `projects/`

This is what powers the non-chat side of the UI.

It also includes recent activity so the user can see what changed without inspecting files manually.

### 3. Copilot sessions and custom tools

When the user sends a chat message, the backend opens or resumes a Copilot session and exposes a constrained toolset.

The important part is that Copilot does not get broad filesystem access. Instead, it gets restricted tools such as:

- `notes_overview`
- `search_notes`
- `capture_root_item`
- `move_root_item`
- `mark_root_item_done`
- `update_root_item`
- `append_project_update`
- `add_project_next_step`
- `list_project_files`

That lets the model reason over the notes and perform common edits while keeping its tool surface smaller than a full local file editor.

When trusted mode is enabled, the chat toolset also includes:

- `read_note`
- `write_note`
- `append_note`

### 4. Structured note operations

The backend focuses on structured operations:

- add an item to `TODAY.md`, `WAITING.md`, or `INBOX.md`
- move an item between root notes
- mark a root-note item as done
- update a root-note item with lightweight metadata such as `ticket`, `link`, `person`, or `context`
- append a dated update to a project note

That is deliberate. It reduces the need for arbitrary full-file rewrites in chat mode.

### 5. Retrieval approach

The current implementation uses local chunked lexical retrieval, not embeddings.

That was intentional:

- it keeps the first version simple
- it avoids requiring a separate vector store immediately
- it works on locked-down work machines more easily
- it still gives the assistant smaller grounded snippets instead of whole-file matches

The architecture leaves room for a later hybrid retrieval layer with local embeddings and a local vector store such as `sqlite-vec` or LanceDB.

## Notes Model

The app is designed to point at any local Notes workspace, for example `~/Desktop/Notes`.
On Windows, that would typically be something like `C:\\Users\\you\\Desktop\\Notes`.

The application assumes:

- core files exist or can be created
- project folders may be free-form
- headings improve summarization and append behavior
- markdown checklist items are useful for actionable work

Project folders do not need a strict schema, but the system works better when files use familiar names such as:

- `status.md`
- `research.md`
- `next-steps.md`

## Architecture Summary

### Frontend flow

1. Check auth status and unlock with the local access key.
2. Load config and dashboard.
3. Show the chat-first UI and optional workspace controls.
4. Submit prompts to `/api/chat`.
5. Render assistant output and tool trace.

### Backend flow

1. Load saved config from `.second-brain/config.json` and the local access key from `.second-brain/auth.json` or `SECOND_BRAIN_ACCESS_KEY`.
2. Scan and index the configured Notes workspace.
3. Start the local API on `127.0.0.1:8787`.
4. On chat requests, create or resume a Copilot session.
5. Let Copilot call custom tools backed by the notes service.
6. Return the final answer and tool log to the frontend.

## Important Files

- `src/App.tsx`: main React UI
- `src/api.ts`: frontend API client and access-key handling
- `server/index.ts`: Express API entrypoint
- `server/auth-store.ts`: local access-key generation and verification
- `server/notes-service.ts`: indexing, retrieval, and file mutation logic
- `server/copilot-service.ts`: Copilot session setup and tool definitions
- `docs/BUILD_PLAN.md`: follow-on roadmap

## Runtime Expectations

To get the full chat experience, the machine running the app needs working GitHub Copilot authentication for the Copilot SDK path being used. Without that, the UI and local indexing still work, but chat requests will fail.

If you are using this with sensitive notes on a work machine, the practical rule is:

- quick actions and local indexing stay local
- chat does not stay fully local because Copilot remains the reasoning layer

For highly sensitive data, prefer the structured local UI actions and be deliberate about what you ask in chat.

If filesystem watch limits are too low in a given environment, the app degrades gracefully and can still refresh after its own writes.

The PWA service worker caches the frontend shell and static assets. The Notes APIs still require the local backend to be running, so installation improves launch and desktop ergonomics more than full offline use.

## Validation Status

The current app has been exercised with:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- authenticated API smoke tests for auth, dashboard, actions, and chat
- restricted-mode chat verification
- trusted-mode chat verification
- end-to-end note mutation checks against a temporary Notes workspace

The codebase is intended to be cross-platform. It uses Node path utilities rather than hard-coded POSIX paths for runtime file access, so the backend should work on macOS, Linux, and Windows. The main environment dependency to validate on a Windows machine is the GitHub Copilot SDK and CLI authentication flow, since that is external to the app itself.

## Windows Notes

If you run the app on Windows:

- use a real Windows path when configuring the Notes root, for example `C:\\Users\\you\\Desktop\\Notes`
- run the same `npm install`, `npm run dev`, `npm run build`, and `npm run start:server` commands
- use Chrome or Edge for the PWA install flow
- expect the frontend shell to install cleanly, but remember the local backend still needs to be running for note access and chat

## Current Status

The project currently provides:

- a working Vite + React UI
- a local Express backend
- a scoped Notes retrieval and mutation layer
- recent activity tracking for note changes
- direct quick-action workflows for common daily operations
- a Copilot-backed chat flow
- end-to-end support for dashboard questions and common note-management tasks

For agent-focused build and run instructions, see `AGENTS.md`.
