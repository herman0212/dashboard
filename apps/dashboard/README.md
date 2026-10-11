# Astra Pentest Dashboard

React/Vite frontend and Node `node:http` server share one localhost origin. New Scan and Stop Scan invoke the existing Astra CLI. Scan execution, workflow progress, agents, findings, logs and reports continue to use the existing workspace and Temporal readers. No second pentest engine or workflow is created.

## Run from repository root

Use Node 22.12+ (Node 24 was used for verification), Git on PATH and the repository's pnpm 10.33.0.

```sh
pnpm install --frozen-lockfile
pnpm dashboard:build
pnpm dashboard
```

Open `http://127.0.0.1:4310`. The build includes the CLI read facade and worker contracts before building the dashboard. The existing root `build`, CLI commands and worker entrypoints remain available.

The default workspace root is this checkout's `workspaces/`. Override `ASTRA_WORKSPACES_DIR` with a trusted absolute directory containing Astra workspaces, and optionally `ASTRA_DASHBOARD_PORT` (1024–65535). For example in PowerShell:

```powershell
$env:ASTRA_WORKSPACES_DIR = 'D:\astra\workspaces'
$env:ASTRA_DASHBOARD_PORT = '4310'
pnpm dashboard
```

Temporal uses the existing CLI connection configuration: `127.0.0.1:7233`, namespace `default`. Dashboard asks the CLI to start scans; the CLI and worker create the real workspace and workflow. No demo scan data is created.

## Scan controls

Astra's CLI rejects native Windows and root/sudo execution. On Linux/WSL2, Dashboard can invoke the existing CLI directly as the same regular user. On Windows, connect Dashboard to the authenticated WSL2 runner using the launcher described below. Without that connection, Start/Stop stay disabled with the concrete reason. Docker and model configuration use the existing CLI mechanisms; no platform guard is bypassed.

Open **New scan**, enter an absolute HTTP(S) target URL and select a configured source directory, confirm your permission to test the target, and select **Start scan**. Only URL and source directory are exposed in this version. Credentials, commands, extra CLI flags and arbitrary workspace/output paths cannot be supplied through HTTP. The generated workspace is always fresh; there is no automatic resume or overwrite.

`ASTRA_DASHBOARD_REPO_ROOTS` is an operator-configured JSON array of existing absolute directories. The default lists only this checkout. Web starts accept only exact configured source directories. Configure trusted source roots in the shell that starts Dashboard to allow other projects. Repository traversal, links/junctions escaping or occurring below those roots, non-directories and Docker mount delimiter paths are rejected.

`ASTRA_WORKSPACES_DIR` now also overrides the CLI workspace root through `getWorkspacesDir()` and `initHome()`. Dashboard passes its resolved root to the CLI subprocess, so the real scan and all existing status/stop/readers use the same root. Existing CLI local/npx defaults are unchanged when this variable is absent. Keep this variable in the shell when using CLI commands to manage scans started through Dashboard.

Control records live outside the worker workspace mount at `<checkout>/.astra-dashboard/<workspace-root-hash>/`. `ASTRA_DASHBOARD_CONTROL_DIR` may override that directory, but placing it inside the workspace root is rejected. Records contain request/workspace identity, bounded fingerprints and observed launcher PID/exit/error codes; they never contain credentials, raw target queries, child output or environment values. CLI stdout/stderr are not published; startup failure details already persisted by Astra remain accessible through the existing readers. Pre-workspace CLI failures expose safe generic error codes and exit status.

The process record describes the CLI launcher, not the scan: `starting`, `running`, `exited`, `failed`, or `unknown` after Dashboard loses the process observation on restart. CLI exit zero does not prove scan completion. The detail page continues to read scan execution from Temporal and durable evidence. Stop Scan calls `astra stop <workspace> --yes`, preserving the existing cancellation grace period, termination fallback and worker cleanup. A successful stop launcher exit is not synthesized into a cancelled workflow state.

UUID request IDs are durable idempotency keys. Retrying an unchanged request reuses its record; changing the request under the same ID returns 409. A matching unresolved start is blocked until a fresh Temporal observation confirms closure, except a proven launcher failure with no workspace. Matching nonterminal workspaces from CLI are also checked when their target is recorded. There is no global guarantee against an independent CLI launch that has not recorded its target yet. A filesystem mutex serializes control mutations; up to four active/unverified launchers of each command kind and 200 history records are supported.

Dashboard shutdown does not imply cancelling Docker/Temporal scans. After an interrupted controller, process observations may be unknown. If a crash leaves `mutation.lock`, or history fills, stop Dashboard, verify existing CLI/workspace/Temporal execution before manually archiving records or removing the stale lock. Never discard unresolved records merely to retry a scan. Unknown/unavailable Temporal evidence keeps duplicate protection closed.

## Data semantics

- `describe` selects the run ID; queries/results are pinned to that execution with `followRuns: false`. Scheduled activities are pending; started activities are running. Prior attempt failures are separate from terminal failure.
- Execution status and business status are distinct. Missing/unreadable evidence remains unknown/null. Temporal outages retain clearly marked stale observations, or unavailable facts if no prior observation exists. Stale elapsed time is frozen at the last observation.
- Agent registries and activity mappings come from the CLI/worker. `pipelines` is never displayed as a real agent. Missing metrics do not prove skipped. Resolved agent counts are explicit completed/skipped members of `expectedAgents`; there is no percentage or ETA.
- Session state establishes durable scope and latest resume identity. It is not a realtime execution feed. Only workflow-keyed terminal metrics can establish an offline business outcome.
- Findings retain source, stage, artifact digest, checkpoint and JSON pointer. Analysis, exploitation, reconciliation, final report and Capella are distinct sources. The default selects one proven source; totals across different stages are not presented as the final vulnerability count.
- Reconciliation requires the existing manifest validator, exact approved consumer paths and all consumer digests. A corrupt manifest is not treated as an absent manifest.
- Capella records use the existing run/finding validators. Saved stage findings are marked partial and workspace-scoped: the current format does not bind them to a workflow/run ID, and private fingerprint inputs are not read. Static confirmation never becomes exploitation.
- Report lifecycle requires the existing report-progress contract. Checkpoint/finalization coherence uses the worker's unchanged validators through a scoped, read-only Git adapter. A report file's existence does not establish finalization.
- JSON, Markdown, PDF and SARIF availability are shown separately. Integrity verification and publication eligibility are separate. Approved report downloads are sanitized dashboard projections. PDFs and raw intermediate narratives are blocked in this MVP because Astra has no secret-safe publication proof for them.

## API

Existing scan GET routes:

| Route | Data |
| --- | --- |
| `/api/scans` | Paginated workspace summaries; `cursor`, `limit` |
| `/api/scans/:workspace` | Overview, workflow stages, agents, issues, source health |
| `/api/scans/:workspace/findings` | Source/stage findings; `source`, `severity`, `confidence`, `outcome`, `q`, `cursor`, `limit` |
| `/api/scans/:workspace/logs` | Sanitized historical events; `agent`, `phase`, `level`, `q`, `cursor`, `direction`, `limit` |
| `/api/scans/:workspace/deliverables` | Artifact registry, integrity and publication eligibility |
| `/api/scans/:workspace/report` | Lifecycle, checkpoints, sanitized metadata and format availability |
| `/api/scans/:workspace/artifacts/:artifactId` | Verified sanitized download from a server-owned artifact ID |

JSON responses include `data` and `meta` (schema version, snapshot ID, observation health, source health and issues). Individual facts carry their health and provenance. Errors use `error` and `meta`. Download responses carry attachment headers and SHA-256 of the returned bytes.

Useful partial/stale responses return 200. Invalid request/query: 400; blocked publication: 403; confirmed absence: 404; identity/dataset/artifact revision conflict: 409; unreadable required source: 503. Scan read routes still reject non-GET methods, except the explicit control routes below.

| New route | Contract |
| --- | --- |
| `GET /api/control/capabilities` | Platform availability/reason, allowed repository roots, workspace root, current CSRF token |
| `POST /api/scans` | `{requestId: UUID, url: string, repository: absolute path, authorized: true}`; returns 202 with launcher operation |
| `GET /api/control/operations` | Bounded persisted control history |
| `GET /api/control/operations/:id` | One observed launcher operation |
| `POST /api/scans/:workspace/stop` | `{requestId: UUID, confirmed: true}`; returns 202 with stop operation |

All mutations require the exact localhost Origin, current `X-Astra-Control` token from the same-origin capabilities endpoint, and `Content-Type: application/json`. No CORS is enabled. Unknown fields/query parameters are rejected. Body limit is 8 KiB with a 10s read deadline. Missing permission confirmation: 400; platform unavailable: 503; duplicate/idempotency/mutex conflict: 409; launcher/history limit: 429. A 202 acknowledges only a control request, not a successfully running scan.

## Polling and security

Scan list: 10s. Active scan detail: 3s; terminal detail: 30s. Logs: 3s when enabled, using signed incremental cursors. Findings/deliverables/report refresh on opening or snapshot revision changes. Requests are abortable, do not overlap within a poller and cannot update a disposed selection. Retries use bounded bursts and then a 30s interval; hidden tabs suspend reads.

Server binds IPv4 loopback and checks Host, Origin and Fetch Metadata. No CORS is enabled. Clients can submit only a validated source directory within operator-configured roots; workspace/artifact paths remain server-owned. CLI execution uses Node spawn with an argument array and `shell: false`. Workspace containment, ancestor link/junction checks, regular-file/hardlink checks, read-size limits and artifact ownership protect file reads. Git reads disable optional locks, executable hooks/fsmonitor and global/system config; deliverables Git directories with executable/external config or links are rejected. Raw unknown log text and tool arguments are withheld; publication uses positive projections and credential redaction. React renders prose as text; raw Markdown HTML is not rendered. CSP limits frontend resources to the same origin.

Limits: 8 HTTP requests; 4 concurrent Temporal reads; 200 scans/page; 200 findings/page; 1,000 log events/page; 256 KiB log read; 10 MiB artifact/Git read; 2,000 workspace directory entries. Cursors are signed with a process-local key and expire when the server restarts or the underlying generation changes.

## Checks

```sh
pnpm dashboard:check
pnpm dashboard:lint
pnpm dashboard:test
pnpm dashboard:build
```

Tests create isolated fixtures only under a temporary directory, optionally `ASTRA_DASHBOARD_TEST_TMP`; they never populate production workspaces. Integration tests compare all workspace bytes before/after reads and exercise actual Git checkpoint/manifest validation and HTTP downloads. Control tests inject a launcher and Temporal observations to test request validation, argv, idempotency, failure and restart semantics; a separate test observes a real Node subprocess. These are automated tests, not proof that Docker/Temporal executed a pentest.

## Windows Dashboard with a WSL2 runner

Double-click `Start-AstraDashboard.cmd` at the repository root. It enumerates the actual WSL distributions and uses `wslpath` for the checkout path; it never guesses a distro or `/mnt/c` path. With several distros it offers a selection. The setup stops explicitly if WSL is inaccessible.

One-time requirements: WSL2 as a regular user, Linux Node 22.12+ and pnpm 10.33.0, Windows Node for the Dashboard, and the existing Astra model configuration/credentials. Enable Docker access in WSL. The setup creates a separate Linux copy/dependency tree under the actual WSL user's XDG data directory, preserving the Windows checkout. An existing checkout `.env` is copied to that protected runtime; no credential values are sent to the frontend. The fixed setup script installs/builds Linux dependencies. A foreground Linux runner is held by a hidden Windows WSL client; an already authenticated running runner is reused. There is no per-scan terminal command.

The launcher connects Windows Dashboard `http://127.0.0.1:4312` to authenticated Linux runner `http://127.0.0.1:4313`. Both bind loopback. Windows requires WSL localhost forwarding; no automatic public bind or portproxy is installed. A token file and `runner-connection.json` are kept under ignored `.astra-dashboard`, and Linux control records are outside the worker workspace/source mounts. Runner endpoints require a server-side bearer token; the browser receives only the independent same-origin CSRF token. Runner mode serves API only. Windows proxies all workspace/Temporal reads to the same runner, including report downloads; it does not map Linux paths or spawn the engine.

Operator configuration, loaded at startup:

- Windows: `ASTRA_DASHBOARD_RUNNER_URL=http://127.0.0.1:4313` plus `ASTRA_DASHBOARD_RUNNER_TOKEN_FILE`, or the launcher's saved connection file.
- Linux runner: `ASTRA_DASHBOARD_RUNNER_TOKEN_FILE`, `ASTRA_WORKSPACES_DIR`, `ASTRA_DASHBOARD_CONTROL_DIR`, `ASTRA_DASHBOARD_SETTINGS_FILE`.
- Linux `settings.json` beside the runtime `source` directory contains `repositoryRoots` (existing absolute source directories) and `allowedPrivateHosts` (exact hostnames/IPs). The launcher reports these actual paths in `paths.json`; sources default to the real Linux copy of this repository. Edit this file once and restart the runner to add sources/private targets, or use the corresponding JSON environment variables `ASTRA_DASHBOARD_REPO_ROOTS` / `ASTRA_DASHBOARD_ALLOWED_PRIVATE_HOSTS` when starting the service directly.

The Start form uses a source select, not free-form filesystem input. Readiness polls every 5s and exposes safe issue codes for runtime, Docker, model configuration and storage. All issues, URL validity, source selection and the authorization checkbox govern Start. Start rechecks readiness and DNS on the runner; it still calls unchanged `astra start --url ... --repo ... --workspace ...` with argv and `shell:false`. Stop uses `astra stop WORKSPACE --yes`; missing model credentials alone do not prevent stopping. A launcher exit still does not imply Temporal completion.

Web target policy denies private/reserved DNS/IP targets by default; exact operator-approved private hosts may be used. Every DNS answer must satisfy the policy. Cloud metadata IPv4/mapped IPv6 and AWS IPv6 metadata cannot be allowed. This is admission validation; it does not implement an engine-wide outbound firewall for every agent request/redirect. Astra's existing in-workflow preflight remains active. No network isolation guarantee beyond those checks is claimed.

When the runner is absent, invalid or unauthenticated, capabilities report the concrete issue and Start remains disabled. With a configured disconnected runner, scan reads return 503 instead of an invented empty Linux workspace list. Setup/API unit fixtures are not production scan data. Running an actual WSL/Docker/Temporal scan and producing its final report requires those dependencies to be accessible.

## Remaining evidence gaps

Precise per-agent completion timestamps and a unified typed realtime event stream are not recorded consistently. They remain unknown or historical. No cross-source finding deduplication is claimed without producer lineage. External customer-output destinations are not enumerated; canonical workspace outputs remain observable. No raw PDF/intermediate artifact download is offered. Docker/worker/Temporal execution and active scan UI require the user's existing runtime and actual scan data.
