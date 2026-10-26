# pi-async-bash

[![CI](https://github.com/chthub/pi-async-bash/actions/workflows/ci.yml/badge.svg)](https://github.com/chthub/pi-async-bash/actions/workflows/ci.yml)

A thin background-job wrapper around **Pi's own bash tool**. Tested with Pi 1.3.0 and Node.js 22.19+.

Pi runs the command. This extension only decides when to stop waiting and how to report its eventual result.

## What it adds

- `bash({ command, background: true })` returns a job ID immediately.
- Normal bash calls automatically move to the background after 60 seconds.
- Completed background jobs send an `async_bash_result` steering message. Pi delivers it at a tool-batch boundary, or wakes the agent when idle. In the TUI, long results use Pi's native bash preview; expand/collapse with `Ctrl+O` (or your configured tool-expansion shortcut), or click in fullscreen mode.
- If Escape clears a completion notice, it is resent after the interrupted run stops. This can wake the agent again without a new user prompt.
- `bash_jobs` lists, inspects, or cancels jobs in the current runtime.
- In interactive TUI mode, a read-only widget below the editor shows active background jobs, elapsed time, and cancellation status.

## What stays native

Every command calls the public `createBashToolDefinition(...).execute(...)`. The current `shellPath` and `shellCommandPrefix` settings are passed through, as is the original tool context.

Pi owns shell selection, environment variables, timeout validation, process cleanup, bounded output buffering, full-output files, streaming-update throttling, truncation, structured results, and tool rendering. Foreground results and thrown errors are returned unchanged. There is no local process runner, no replacement truncator, no output-file copy, and no global context hook or session-file rewrite.

The native implementation may change with Pi updates. This project deliberately follows it rather than freezing a second implementation.

## Try it

Do **not** load this alongside `pi-background-bash` or another extension that replaces `bash`. First disable the old extension for the test session. To try this project alone, from its directory:

```sh
pi --no-extensions -e ./src/index.ts
```

To enable codemode as well:

```sh
pi --no-extensions -e ./src/index.ts -e builtin:codemode --tools +codemode
```

Install the published npm package **`@chthub/pi-async-bash`** after removing/disabling the old bash override. The unscoped npm package `pi-async-bash` belongs to an unrelated publisher; do not use `pi install npm:pi-async-bash` for this project.

```sh
pi install npm:@chthub/pi-async-bash
```

Alternatively, install from GitHub:

```sh
pi install git:github.com/chthub/pi-async-bash
```

Or install a local checkout:

```sh
pi install /path/to/pi-async-bash
```

The extension does not modify your settings or remove other packages automatically.

## Bash results

A command that finishes in the foreground returns **the native result**, including the native object for codemode callers:

```js
const result = await tools.bash({ command: "printf hello" });
// { output: "hello", truncated: false, exit_code: 0, wall_time_seconds: ... }
```

A command that moves to the background returns a different object:

```js
const result = await tools.bash({ command: "npm test", background: true });
// { status: "running", job_id: "bg-..." }
```

`status: "running"` acknowledges scheduling; it does not mean the command succeeded. The eventual notification is not a second return value from the original call. Nonzero foreground exits retain Pi's error-result/structured-output behavior; foreground timeout and abort still reject. Background errors appear in the completion notification.

Automatic backgrounding can be configured for an invocation:

```sh
pi -e ./src/index.ts --bash-background-after 10
pi -e ./src/index.ts --bash-background-after 0
```

`0` disables automatic backgrounding; explicit `background: true` remains available. `background: false` uses the configured automatic threshold. This project does not read old PBB configuration files.

## Inspect and cancel

```js
await tools.bash_jobs({ action: "list" });
await tools.bash_jobs({ action: "status", job_id: "bg-..." });
await tools.bash_jobs({ action: "cancel", job_id: "bg-..." });
```

Job IDs use `bg-` plus eight random lowercase hexadecimal characters (for example, `bg-a3f81c92`). Collisions with IDs in the current registry are retried. IDs are runtime-local, not persistent handles.

`action` must be `"list"`, `"status"`, or `"cancel"`. `job_id` is required for `status` and `cancel`. Codemode calls resolve to a string, not a structured object; use `text(...)` to display it.

Status returns the latest **native bounded output snapshot**, state, and optional exit code. If Pi has spilled large output to a file, status includes `full_output_path`; use the normal `read` tool to inspect it. Short output may have no file. While a job is running, its native full-output file is still being written.

Cancellation requests the native AbortController path. It first reports `cancelling`; the job's final notification establishes its terminal state. On Unix, Pi's current implementation terminates the process group with SIGKILL; this is not a graceful SIGTERM interface.

Job lists show at most the 20 most recently started jobs. The registry retains all running jobs, undelivered completions, and at most 20 completions confirmed in the conversation. Foreground jobs are not retained. Completed jobs retain only the bounded native snapshot, not the larger structured `output` object. Native output-file retention is controlled by Pi.

## TUI task widget

A separate UI component appears **below the editor**, without replacing Pi's footer. It shows the active count and up to three task rows: complete short job ID, running/cancelling state, elapsed time, and a command preview. Additional jobs are summarized as `+N more`; use `bash_jobs` for the full list and details.

The display refreshes once per second while jobs are active, disappears when none remain, and cleans up its timer on shutdown/reload. It handles narrow terminals, wide characters, and theme changes using Pi's own TUI utilities. Only the command preview is sanitized and shortened for display; execution and model-facing output are untouched.

This is a read-only view of the job registry. It neither controls execution nor sends model messages. RPC, JSON, and print modes create no widget or UI timer.

## Lifetime and deliberate limits

- Jobs are owned by one live extension runtime. Shutdown, reload, session replacement, and branch navigation cancel running jobs and discard the registry. This is not a daemon or a scheduler for jobs that must survive Pi exiting.
- Navigation is fail-closed: a switch/fork/tree navigation **attempt** cancels jobs even if another extension later vetoes the navigation.
- Enqueueing a steer is not treated as delivery. The original job ID is captured when Pi starts consuming the message, and delivery is confirmed at a turn boundary. Later message transformations by other extensions cannot cause the original result to be replayed. If Escape clears a queued result before consumption, the result is retained and sent again once the aborted run has settled. That steer may immediately wake the model; no new user prompt is required. The original command is never rerun. Messages still queued or already consumed are not resent; clearing a later attempt permits one further retry after the next abort settles.
- Queue-loss detection uses Pi's public `turn_end` snapshot. In Pi's default one-at-a-time steering mode that snapshot shows only the queue head, so a queued result is treated as lost only when the snapshot is empty; results waiting behind other queued messages are never resent. If another extension clears the queue after the final snapshot (for example inside a delayed `agent_end` handler), Pi exposes no fresh queue snapshot at settlement; detection/recovery then occurs at a later turn boundary. The plugin does not intercept Esc or access private queues.
- A result already queued with Pi cannot be recalled. Generation checks suppress results not yet sent after cleanup.
- Print/JSON mode may exit after the initial response; do not expect a background job to survive that exit. Use a live interactive/RPC session when waiting for later notifications.
- There is no `pbb` CLI, cross-runtime job inspection, `pi-lane` dependency, PID registry, arbitrary signal selection, stale-process killing, restart recovery, or session repair.
- The original bash call still goes through Pi's tool hooks. The eventual background completion is a custom message, **not another `tool_result` event**. Extensions that redact only tool results do not automatically redact completion messages.
- In codemode, a script may discard a running acknowledgement instead of printing it. Completion notifications therefore include their own job ID and a command preview.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run test:integration
```

Only documented/public Pi APIs are imported. Host libraries are peer dependencies; development pins Pi 1.3.0 for reproducible compatibility tests. Tests use temporary fixtures and do not require real model credentials.

## CI and publishing

GitHub Actions runs CI on Node.js 22.19.0 and 24. An opt-in release workflow supports public npm publishing through OIDC trusted publishing and provenance, with tests and release guards before upload. Both release events and manual retries require a published, non-prerelease GitHub Release; a stable-looking version number alone is insufficient. The package `@chthub/pi-async-bash` is published on npm. After npm-side trust is configured and `NPM_PUBLISH_ENABLED` is enabled, publishing a stable GitHub Release triggers the automated publishing workflow. See [publishing setup](docs/publishing.md).

## License

MIT
