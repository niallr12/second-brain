# AGENTS.md

## Purpose

This repository is a local AI notes assistant built with a Vite React frontend and a Node/Express backend. The backend indexes a configurable Markdown workspace and exposes constrained tools to the GitHub Copilot SDK.

If you are an agent working in this repo, focus on:

- keeping the frontend and backend in sync
- preserving the Notes-root safety boundary
- validating changes with the standard checks before you stop

## Stack

- Node.js
- npm
- TypeScript
- React 19
- Vite 8
- Express 5
- GitHub Copilot SDK

## Prerequisites

- Node.js 20+ preferred
- npm available
- GitHub Copilot authentication available on the machine if you need live chat to work

The app can still build and load its dashboard without Copilot auth, but `/api/chat` will not work correctly without it.

## Install

From the repo root:

```bash
npm install
```

## Run

### Full development mode

Starts both the frontend and backend:

```bash
npm run dev
```

Expected ports:

- frontend: `http://localhost:5173`
- backend: `http://localhost:8787`

These scripts are intended to work on Windows as well as macOS/Linux. Prefer `npm` scripts over ad hoc shell one-liners.

### Backend only

```bash
npm run start:server
```

Useful for API validation with `curl`.

### Production build

```bash
npm run build
```

For PWA install validation, serve the built frontend from `localhost` or HTTPS and confirm:

- `/manifest.webmanifest` loads
- `/service-worker.js` registers
- the browser exposes the install prompt or menu entry

## Validation commands

Run these after code changes:

```bash
npm run lint
npm run typecheck
npm run build
```

If you touch the backend or Copilot tool flow, also do a runtime smoke test:

```bash
npm run start:server
curl -s http://localhost:8787/api/health
curl -s http://localhost:8787/api/dashboard
curl -s http://localhost:8787/api/activity
```

PowerShell equivalents:

```powershell
npm run start:server
Invoke-RestMethod http://localhost:8787/api/health
Invoke-RestMethod http://localhost:8787/api/dashboard
Invoke-RestMethod http://localhost:8787/api/activity
```

If Copilot auth is available, you can also probe chat:

```bash
curl -s -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"What do I need to work on today?"}'
```

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:8787/api/chat `
  -ContentType 'application/json' `
  -Body '{"prompt":"What do I need to work on today?"}'
```

You can validate structured quick actions without chat:

```bash
curl -s -X POST http://localhost:8787/api/actions \
  -H 'Content-Type: application/json' \
  -d '{"type":"capture-root-item","target":"INBOX.md","item":"Example reminder"}'
```

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:8787/api/actions `
  -ContentType 'application/json' `
  -Body '{"type":"capture-root-item","target":"INBOX.md","item":"Example reminder"}'
```

## Notes workspace behavior

Default sample workspace:

- `sample-data/Notes` when present locally for testing

Config persistence:

- `.second-brain/config.json`

The configured Notes root is allowed to vary at runtime through the UI, but backend file operations must remain scoped to that root. Do not introduce code paths that read or write outside it.

Windows notes:

- the runtime code is path-aware and should accept Windows paths such as `C:\\Users\\you\\Desktop\\Notes`
- prefer testing backend startup and Copilot auth on a real Windows machine before claiming full Windows support
- prefer PowerShell-native commands such as `Invoke-RestMethod` instead of assuming `curl`, `sed`, or other POSIX tools are available
- when editing docs or examples, avoid hard-coding POSIX-only paths or shell syntax unless there is also a Windows equivalent

## Important files

- `src/App.tsx`: main UI
- `src/api.ts`: frontend API client
- `server/index.ts`: backend API entrypoint
- `server/notes-service.ts`: indexing, chunked search, and mutations
- `server/copilot-service.ts`: Copilot setup and tool registration
- `.second-brain/activity.json`: persisted recent activity log
- `sample-data/Notes/`: test corpus

## Agent expectations

When modifying this repo:

- prefer changing backend behavior in `server/notes-service.ts` and keeping Copilot tool wrappers thin
- preserve structured tools for root-note operations instead of falling back to full-file rewrites
- keep user-visible notes operations safe and deterministic
- keep the README focused on architecture and technologies
- keep this file focused on build, run, validation, and agent workflow

## Known runtime notes

- In some environments, filesystem watchers may hit open-file limits. The backend is expected to degrade gracefully rather than crash.
- The Copilot CLI subprocess may emit an experimental SQLite warning. That is upstream runtime noise, not necessarily a regression in this repo.
