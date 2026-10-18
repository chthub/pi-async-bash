import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
// Resolve the installed package, not a developer's global CLI or private checkout.
const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const manifest = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8"));
const cli = join(piRoot, typeof manifest.bin === "string" ? manifest.bin : manifest.bin.pi);
const text = (message) => typeof message.content === "string" ? message.content :
  (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
const jsonl = (value) => value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

async function launch(t, steps, { after = "0", codemode = false, dynamicTool = false } = {}) {
  assert.equal(manifest.version, "1.3.0", "Integration contract requires installed Pi 1.3.0");
  const dir = await mkdtemp(join(tmpdir(), "pi-async-bash-integration-"));
  let child;
  let closed;
  let stopped = false;
  t.after(async () => {
    try {
      if (child && !stopped) await stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  for (const name of ["home", "agent", "work", "tmp", "sessions"]) await mkdir(join(dir, name));
  await writeFile(join(dir, "plan.json"), JSON.stringify({ steps, dynamicTool }));
  await writeFile(join(dir, "agent", "settings.json"), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  const args = [cli, "--mode", "rpc", "--offline", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--no-approve",
    "--extension", join(root, "test/fixtures/scripted-provider.mjs"),
    "--extension", join(root, "src/index.ts"),
    ...(codemode ? ["--extension", "builtin:codemode"] : []),
    "--provider", "async-bash-test", "--model", "scripted", "--thinking", "off",
    // An allowlist removes other tools from Pi's registry, including late ones.
    "--tools", dynamicTool ? "+bash_jobs,-read,-write,-edit" : `bash,bash_jobs${codemode ? ",codemode" : ""}`,
    "--session-dir", join(dir, "sessions"), "--bash-background-after", after];
  child = spawn(process.execPath, args, {
    cwd: join(dir, "work"),
    // Deliberate allowlist: do not inherit API keys, provider config, NODE_OPTIONS,
    // shell startup hooks, or the developer's Pi extension/settings directories.
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(dir, "home"),
      TMPDIR: join(dir, "tmp"), LANG: "C.UTF-8", TERM: "dumb", PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: join(dir, "agent"),
      ASYNC_BASH_TEST_PLAN: join(dir, "plan.json"),
      ASYNC_BASH_TEST_REQUESTS: join(dir, "requests.jsonl") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let stderr = "";
  let pending = "";
  let failure;
  closed = new Promise((done) => {
    child.once("error", (error) => { failure = error; done(); });
    child.once("close", (code, signal) => { stopped = true; done({ code, signal }); });
  });
  child.stdin.on("error", (error) => { failure ??= error; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, "");
      pending = pending.slice(end + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); }
      catch { failure = new Error(`Non-JSON RPC output: ${line.slice(0, 200)}`); }
    }
  });
  async function wait(predicate, label, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      const error = events.find((event) => event.type === "extension_error" ||
        (event.type === "message_end" && event.message?.stopReason === "error"));
      if (failure || error || stopped || Date.now() > deadline) {
        throw new Error(`${label}: ${failure?.message ?? error?.error ?? error?.message?.errorMessage ??
          (stopped ? "Pi exited" : "timed out")}\n${stderr}\nRecent event types: ${events.slice(-12).map((event) => event.type).join(", ")}`);
      }
      await delay(20);
    }
  }
  let sequence = 0;
  async function command(type, fields = {}) {
    const id = `rpc-${sequence++}`;
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    await wait(() => events.some((event) => event.type === "response" && event.id === id), type);
    const response = events.find((event) => event.type === "response" && event.id === id);
    assert.equal(response.success, true, `${type}: ${response.error}`);
    return response.data;
  }
  async function stop() {
    child.stdin.end();
    let timer;
    try {
      const result = await Promise.race([closed, new Promise((done) => {
        timer = setTimeout(() => done(null), 5000);
      })]);
      if (result === null) { child.kill("SIGKILL"); await closed; }
      assert.notEqual(result, null, "Pi must shut down and dispose background jobs on stdin EOF");
      assert.equal(result?.code, 0, `Pi exit: ${JSON.stringify(result)}\n${stderr}`);
    } finally { clearTimeout(timer); }
  }
  await command("get_state");
  return {
    events, command, wait, dir, stop,
    async run() { await command("prompt", { message: "Run the local integration script." }); },
    async finish(completions = 1) {
      await wait(() => events.filter((event) => event.type === "message_end" &&
        event.message?.customType === "async_bash_result").length >= completions, "background completion");
      // A completion can arrive after the first agent_settled; require settlement
      // after the last custom result, not merely the initial tool acknowledgement.
      await wait(() => {
        const last = events.findLastIndex((event) => event.type === "message_end" &&
          event.message?.customType === "async_bash_result");
        return events.some((event, index) => index > last && event.type === "agent_settled");
      }, "completion continuation settled");
      return this.snapshot();
    },
    async snapshot() {
      const state = await command("get_state");
      assert.ok(state.sessionFile, "Pi must persist a real session");
      const entries = jsonl(await readFile(state.sessionFile, "utf8"));
      const requests = jsonl(await readFile(join(dir, "requests.jsonl"), "utf8"));
      return { entries, requests, messages: entries.filter((entry) => entry.type === "message").map((entry) => entry.message),
        completions: entries.filter((entry) => entry.type === "custom_message" && entry.customType === "async_bash_result") };
    },
  };
}

function checkHistory({ entries, requests, messages, completions }, toolName, marker) {
  assert.equal(completions.length, 1, "exactly one persisted completion");
  const result = messages.find((message) => message.role === "toolResult" && message.toolName === toolName);
  assert.ok(result, `saved ${toolName} acknowledgement`);
  assert.equal(result.isError, false);
  const ackIndex = entries.findIndex((entry) => entry.message === result);
  assert.ok(entries.indexOf(completions[0]) > ackIndex, "completion must follow parent tool result in saved transcript");
  assert.match(text(result), /bg-[a-f0-9-]+/);
  assert.match(text(completions[0]), new RegExp(marker));
  assert.equal(entries.some((entry) => entry.type === "context_edit"), false, "no history repair/context guard");
  for (let index = 1; index < requests.length; index++) {
    assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length),
      requests[index - 1].messages, "existing provider context is append-only");
  }
  return result;
}

for (const mode of ["explicit", "automatic", "fast explicit"]) {
  test(`real Pi: ${mode} bash acknowledgement precedes one completion`, { timeout: 45000 }, async (t) => {
    const command = `${mode === "fast explicit" ? "" : "sleep 0.3; "}printf direct-complete`;
    const pi = await launch(t, [{ tool: "bash", args: { command, ...(mode === "automatic" ? {} : { background: true }) } }],
      { after: mode === "automatic" ? "0.02" : "0" });
    await pi.run();
    const saved = await pi.finish();
    checkHistory(saved, "bash", "direct-complete");
    assert.equal(saved.completions[0].details.state, "completed");
    assert.equal(saved.completions[0].details.exit_code, 0);
    assert.equal(pi.events.filter((event) => event.type === "tool_execution_start" && event.toolName === "bash").length, 1,
      "the command is not rerun to wait");
  });
}

test("real Pi: foreground keeps native structured output and creates no job", { timeout: 45000 }, async (t) => {
  const pi = await launch(t, [
    { tool: "codemode", args: { code: 'const result = await tools.bash({command: "printf foreground-ok"}); if (result.exit_code !== 0 || result.output !== "foreground-ok" || "job_id" in result) throw Error("wrong native result"); text(result.output);' } },
    { tool: "bash_jobs", args: { action: "list" } },
  ], { codemode: true });
  await pi.run();
  await pi.wait(() => pi.events.some((event) => event.type === "agent_settled"), "foreground settled");
  const saved = await pi.snapshot();
  assert.equal(saved.completions.length, 0);
  assert.ok(saved.messages.some((message) => message.toolName === "codemode" && !message.isError && text(message).includes("foreground-ok")));
  const listed = saved.messages.find((message) => message.toolName === "bash_jobs");
  assert.deepEqual(JSON.parse(text(listed)), { total: 0, jobs: [] });
});

test("real Pi: nested codemode job completes while parent is still running", { timeout: 45000 }, async (t) => {
  const pi = await launch(t, [{ tool: "codemode", args: { code: `
    const job = await tools.bash({command: "printf nested-complete; touch nested-done", background: true});
    if (job.status !== "running" || !job.job_id) throw Error("missing structured acknowledgement");
    text(job);
    text(await tools.bash({command: "while [ ! -f nested-done ]; do sleep 0.02; done; sleep 0.2; printf parent-done"}));
  ` } }], { codemode: true });
  await pi.run();
  const saved = await pi.finish();
  const result = checkHistory(saved, "codemode", "nested-complete");
  assert.match(text(result), /parent-done/);
  assert.equal(saved.messages.some((message) => message.role === "toolResult" && message.toolName === "bash"), false,
    "nested bash results are not separate transcript messages");
  const nested = pi.events.filter((event) => event.type === "tool_execution_end" && event.toolName === "bash");
  assert.equal(nested.length, 2);
  assert.ok(nested.every((event) => event.parentToolCallId === "scripted-0"));
});

test("real Pi: automatic backgrounding inside builtin codemode preserves structured acknowledgement", { timeout: 45000 }, async (t) => {
  const pi = await launch(t, [{ tool: "codemode", args: { code: `
    const result = await tools.bash({command: "sleep 0.3; printf nested-auto-complete"});
    if (result.status !== "running" || !result.job_id) throw Error("missing automatic acknowledgement");
    text(result);
  ` } }], { codemode: true, after: "0.02" });
  await pi.run();
  checkHistory(await pi.finish(), "codemode", "nested-auto-complete");
});

test("real Pi: native nonzero background exit is reported once with its exit code", { timeout: 45000 }, async (t) => {
  const pi = await launch(t, [{ tool: "bash", args: {
    command: "printf native-failure; exit 7", background: true,
  } }]);
  await pi.run();
  const saved = await pi.finish();
  checkHistory(saved, "bash", "native-failure");
  assert.equal(saved.completions[0].details.state, "failed");
  assert.equal(saved.completions[0].details.exit_code, 7);
});

test("real Pi: bash_jobs list/status/cancel cancels the native process", { timeout: 45000 }, async (t) => {
  const pi = await launch(t, [
    { tool: "bash", args: { command: 'echo $$ > cancelled.pid; printf started; sleep 30; touch must-not-exist', background: true } },
    { tool: "bash", args: { command: "while [ ! -f cancelled.pid ]; do sleep 0.01; done", timeout: 5 } },
    { tool: "bash_jobs", args: { action: "list" } },
    { tool: "bash_jobs", args: { action: "status", job_id: "$JOB" } },
    { tool: "bash_jobs", args: { action: "cancel", job_id: "$JOB" } },
  ]);
  await pi.run();
  const saved = await pi.finish();
  checkHistory(saved, "bash", "cancel|abort");
  assert.equal(saved.completions[0].details.state, "cancelled");
  const management = saved.messages.filter((message) => message.toolName === "bash_jobs");
  assert.equal(management.length, 3);
  assert.ok(management.every((message) => !message.isError));
  const list = JSON.parse(text(management[0]));
  assert.equal(list.total, 1);
  assert.equal(list.jobs[0].job_id, saved.completions[0].details.job_id);
  assert.equal((await readdir(join(pi.dir, "work"))).includes("must-not-exist"), false);
  const pid = Number(await readFile(join(pi.dir, "work", "cancelled.pid"), "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "native shell was terminated");
});

test("real Pi: RPC stdin EOF cancels a live job without a shutdown notification", { timeout: 45000 }, async (t) => {
  const pi = await launch(t, [
    { tool: "bash", args: {
      command: "echo $$ > shutdown.pid; sleep 30; touch shutdown-must-not-exist", background: true,
    } },
    { tool: "bash", args: { command: "while [ ! -f shutdown.pid ]; do sleep 0.01; done", timeout: 5 } },
  ]);
  await pi.run();
  await pi.wait(() => pi.events.some((event) => event.type === "agent_settled"), "idle with live background job");
  const state = await pi.command("get_state");
  const pid = Number(await readFile(join(pi.dir, "work", "shutdown.pid"), "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 1);
  process.kill(pid, 0); // Establish that we are actually cancelling a live shell.
  await pi.stop();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "shutdown must terminate the native shell");
  assert.equal((await readdir(join(pi.dir, "work"))).includes("shutdown-must-not-exist"), false);
  const entries = jsonl(await readFile(state.sessionFile, "utf8"));
  assert.equal(entries.some((entry) => entry.customType === "async_bash_result"), false,
    "no completion may be persisted during shutdown");
  assert.equal(pi.events.some((event) => event.message?.customType === "async_bash_result"), false,
    "no completion may be delivered to a shutting-down session");
});

test("real Pi: late tool registration coexists with completion and append-only history", { timeout: 45000 }, async (t) => {
  const pi = await launch(t, [
    { tool: "bash", args: { command: "sleep 0.3; printf dynamic-complete", background: true } },
    { tool: "late_probe", args: {} },
  ], { dynamicTool: true });
  await pi.run();
  const saved = await pi.finish();
  checkHistory(saved, "bash", "dynamic-complete");
  assert.equal(saved.requests[0].tools.includes("late_probe"), false);
  assert.ok(saved.requests.slice(1).some((request) => request.tools.includes("late_probe")));
  assert.ok(saved.messages.some((message) => message.toolName === "late_probe" && text(message) === "late-tool-ok"));
});
