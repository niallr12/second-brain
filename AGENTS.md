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
The email helper at `/api/email` also depends on Copilot auth and accepts an optional incoming email for context.

The backend is access-key protected. On first run it creates `.second-brain/auth.json` unless `SECOND_BRAIN_ACCESS_KEY` is already set.

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
- backend: `http://127.0.0.1:8787`

These scripts are intended to work on Windows as well as macOS/Linux. Prefer `npm` scripts over ad hoc shell one-liners.

### Backend only

```bash
npm run start:server
```

Useful for API validation with `curl`.

When the backend starts, retrieve the local access key from one of:

- `.second-brain/auth.json`
- `SECOND_BRAIN_ACCESS_KEY`

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
cat .second-brain/auth.json
curl -s http://127.0.0.1:8787/api/auth/status
curl -s -X POST http://127.0.0.1:8787/api/auth/verify \
  -H 'Content-Type: application/json' \
  -d '{"accessKey":"<ACCESS_KEY>"}'
curl -s http://127.0.0.1:8787/api/dashboard \
  -H 'x-second-brain-key: <ACCESS_KEY>'
curl -s http://127.0.0.1:8787/api/activity \
  -H 'x-second-brain-key: <ACCESS_KEY>'
curl -s -X POST http://127.0.0.1:8787/api/email \
  -H 'Content-Type: application/json' \
  -H 'x-second-brain-key: <ACCESS_KEY>' \
  -d '{"subject":"ALB follow-up","goal":"Make this clearer and shorter.","draft":"Hi team, just checking in on the ALB request because I wanted to see if there was any update and if not no worries but if there is anything needed from me let me know."}'
```

PowerShell equivalents:

```powershell
npm run start:server
Get-Content .second-brain/auth.json
Invoke-RestMethod http://127.0.0.1:8787/api/auth/status
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8787/api/auth/verify `
  -ContentType 'application/json' `
  -Body '{"accessKey":"<ACCESS_KEY>"}'
Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/api/dashboard `
  -Headers @{ 'x-second-brain-key' = '<ACCESS_KEY>' }
Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/api/activity `
  -Headers @{ 'x-second-brain-key' = '<ACCESS_KEY>' }
```

If Copilot auth is available, you can also probe chat:

```bash
curl -s -X POST http://127.0.0.1:8787/api/chat \
  -H 'Content-Type: application/json' \
  -H 'x-second-brain-key: <ACCESS_KEY>' \
  -d '{"prompt":"What do I need to work on today?"}'
```

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8787/api/chat `
  -ContentType 'application/json' `
  -Headers @{ 'x-second-brain-key' = '<ACCESS_KEY>' } `
  -Body '{"prompt":"What do I need to work on today?"}'
```

To validate trusted mode specifically:

1. Update config with `"trustedMode": true`.
2. Start a fresh chat session.
3. Send a prompt that genuinely requires a full-file read, for example asking for the first heading of `projects/new-alb/request-process.md`.
4. Confirm the chat tool trace includes `read_note`.

You can validate structured quick actions without chat:

```bash
curl -s -X POST http://127.0.0.1:8787/api/actions \
  -H 'Content-Type: application/json' \
  -H 'x-second-brain-key: <ACCESS_KEY>' \
  -d '{"type":"capture-root-item","target":"INBOX.md","item":"Example reminder"}'
```

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8787/api/actions `
  -ContentType 'application/json' `
  -Headers @{ 'x-second-brain-key' = '<ACCESS_KEY>' } `
  -Body '{"type":"capture-root-item","target":"INBOX.md","item":"Example reminder"}'
```

## Notes workspace behavior

Default sample workspace:

- `sample-data/Notes` when present locally for testing

Config persistence:

- `.second-brain/config.json`
- `.second-brain/auth.json`

Relevant config fields:

- `notesPath`
- `model`
- `trustedMode`

The configured Notes root is allowed to vary at runtime through the UI, but backend file operations must remain scoped to that root. Do not introduce code paths that read or write outside it.

Security constraints:

- keep the API bound to loopback only
- preserve access-key authentication for all protected routes
- broad Copilot file tools are only allowed behind the explicit config-backed `trustedMode` toggle
- remember that chat still sends selected note context to Copilot; local quick actions do not

Validation guidance:

- use a temporary copy of `sample-data/Notes` for runtime mutation smoke tests when possible
- do not leave test tasks or test project updates behind in the sample workspace

Windows notes:

- the runtime code is path-aware and should accept Windows paths such as `C:\\Users\\you\\Desktop\\Notes`
- prefer testing backend startup and Copilot auth on a real Windows machine before claiming full Windows support
- prefer PowerShell-native commands such as `Invoke-RestMethod` instead of assuming `curl`, `sed`, or other POSIX tools are available
- when editing docs or examples, avoid hard-coding POSIX-only paths or shell syntax unless there is also a Windows equivalent

## Important files

- `src/App.tsx`: main UI
- `src/api.ts`: frontend API client
- `server/index.ts`: backend API entrypoint
- `server/auth-store.ts`: local access-key generation and verification
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
