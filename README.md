# Second Brain

Second Brain is a local AI assistant for a PARA-style notes workspace. It is designed to help a single user manage Markdown files such as `TODAY.md`, `WAITING.md`, `INBOX.md`, and project folders under `projects/`, using GitHub Copilot as the reasoning layer and a small local API as the control layer.

The intent is simple: instead of manually opening and editing note files, you ask the assistant questions such as:

- What do I need to work on today?
- What is the latest on a specific project?
- How do I raise a request for a new ALB?
- Move this item from waiting to today.
- Add an update to a project status note.

The application reads and updates the Notes workspace automatically, but it does so through constrained tools rather than unrestricted shell access.

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
- inspect the current state of core notes
- browse project summaries
- run direct quick actions for capture, triage, completion, and project updates
- review recent changes made by the assistant or quick actions
- submit chat prompts to the backend

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
- performs safe scoped file writes inside the configured Notes root

### AI Layer

- GitHub Copilot SDK for session management and tool orchestration
- Custom tools for search, read, write, append, task capture, task movement, task completion, and project updates

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

The important part is that Copilot does not get broad filesystem access. Instead, it gets purpose-built tools such as:

- `notes_overview`
- `search_notes`
- `read_note`
- `write_note`
- `append_note`
- `capture_root_item`
- `move_root_item`
- `mark_root_item_done`
- `append_project_update`
- `list_project_files`

That lets the model reason over the notes and perform edits, while keeping all reads and writes limited to the configured Notes directory.

### 4. Structured note operations

The backend supports two classes of edits.

Generic file operations:

- read a note
- replace a full note
- append to a note

Structured operations:

- add an item to `TODAY.md`, `WAITING.md`, or `INBOX.md`
- move an item between root notes
- mark a root-note item as done
- append a dated update to a project note

The structured operations are important because they let the assistant handle common workflows without rewriting whole files unnecessarily.

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

1. Load config and dashboard.
2. Show root-note summaries and project summaries.
3. Submit prompts to `/api/chat`.
4. Render assistant output and tool trace.

### Backend flow

1. Load saved config from `.second-brain/config.json`.
2. Scan and index the configured Notes workspace.
3. Start the local API.
4. On chat requests, create or resume a Copilot session.
5. Let Copilot call custom tools backed by the notes service.
6. Return the final answer and tool log to the frontend.

## Important Files

- `src/App.tsx`: main React UI
- `server/index.ts`: Express API entrypoint
- `server/notes-service.ts`: indexing, retrieval, and file mutation logic
- `server/copilot-service.ts`: Copilot session setup and tool definitions
- `docs/BUILD_PLAN.md`: follow-on roadmap

## Runtime Expectations

To get the full chat experience, the machine running the app needs working GitHub Copilot authentication for the Copilot SDK path being used. Without that, the UI and local indexing still work, but chat requests will fail.

If filesystem watch limits are too low in a given environment, the app degrades gracefully and can still refresh after its own writes.

The PWA service worker caches the frontend shell and static assets. The Notes APIs still require the local backend to be running, so installation improves launch and desktop ergonomics more than full offline use.

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
