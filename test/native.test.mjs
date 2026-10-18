import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import asyncBash from "../src/index.ts";

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const nodeCommand = (source) => `${quote(process.execPath)} -e ${quote(source)}`;
const textOf = (result) => result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
const digest = (value) => ({ bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") });

async function fixture(t, { after = "0", settings = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-async-bash-test-"));
  const tools = new Map();
  const handlers = new Map();
  const flags = new Map([["bash-background-after", after]]);
  const messages = [];
  const logPaths = new Set();
  const timeline = [];
  const ctx = {
    cwd,
    model: { provider: "fixture-provider", id: "fixture-model" },
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "fixture-session",
      getSessionFile: () => join(cwd, "fixture-session.jsonl"),
    },
  };
  const track = (result) => {
    const path = result?.details?.fullOutputPath ?? result?.structuredContent?.full_output_path;
    if (path) logPaths.add(path);
  };
  const api = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerFlag(name, definition) { if (!flags.has(name)) flags.set(name, definition.default); },
    getFlag(name) { return flags.get(name); },
    getSettings() { return { ...settings }; },
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => handlers.set(name, list.filter((entry) => entry !== handler));
    },
    sendMessage(message, options) {
      timeline.push("send");
      messages.push({ message, options });
      if (message.details?.full_output_path) logPaths.add(message.details.full_output_path);
    },
  };
  asyncBash(api);
  async function emit(type, event = {}) {
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
  }
  t.after(async () => {
    await emit("session_shutdown", { reason: "quit" });
    await immediate();
    // Native output files are temporary files outside cwd: explicitly remove all
    // paths observed in official update/results or completion notifications.
    await Promise.all([...logPaths].map((path) => rm(path, { force: true })));
    await rm(cwd, { recursive: true, force: true });
  });
  await emit("session_start", { reason: "startup" });
  let sequence = 0;
  const invoke = async (args, { signal, onUpdate, id = `call-${++sequence}` } = {}) => {
    const result = await tools.get("bash").execute(id, args, signal, (update) => {
      track(update);
      onUpdate?.(update);
    }, ctx);
    track(result);
    timeline.push(`return:${id}`);
    return { result, id };
  };
  const acknowledge = async (id, result, parentToolCallId) => {
    timeline.push(`ack-start:${id}`);
    await emit("tool_result", {
      toolName: "bash", toolCallId: id, input: {}, ...result,
      ...(parentToolCallId ? { parentToolCallId } : {}),
    });
    timeline.push(`ack-end:${id}`);
  };
  const native = async (args) => {
    const tool = createBashToolDefinition(cwd, {
      shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix,
    });
    const result = await tool.execute("oracle", args, undefined, track, ctx);
    track(result);
    return result;
  };
  const jobs = async (action, job_id) => tools.get("bash_jobs").execute("inspect", { action, job_id }, undefined, undefined, ctx);
  const status = async (job_id) => JSON.parse((await jobs("status", job_id)).content[0].text);
  return { tools, flags, settings, ctx, messages, timeline, emit, invoke, acknowledge, native, jobs, status };
}

async function until(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await predicate();
    if (result) return result;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail(message);
}

function comparable(result) {
  const copy = structuredClone(result);
  const paths = [copy.details?.fullOutputPath, copy.structuredContent?.full_output_path].filter(Boolean);
  for (const path of paths) {
    for (const block of copy.content) if (block.type === "text") block.text = block.text.replaceAll(path, "<native-log>");
  }
  if (copy.details?.fullOutputPath) copy.details.fullOutputPath = "<native-log>";
  if (copy.structuredContent) {
    assert.equal(typeof copy.structuredContent.wall_time_seconds, "number");
    assert.ok(copy.structuredContent.wall_time_seconds >= 0);
    delete copy.structuredContent.wall_time_seconds;
    if (copy.structuredContent.full_output_path) copy.structuredContent.full_output_path = "<native-log>";
  }
  // Keep assertion diagnostics small even when a regression affects 1 MiB of output.
  for (const block of copy.content) {
    if (block.type === "text" && block.text.length > 2048) block.text = digest(block.text);
  }
  if (copy.structuredContent?.output?.length > 2048) copy.structuredContent.output = digest(copy.structuredContent.output);
  return copy;
}

test("real native foreground parity: whitespace, empty stdout, stderr and nonzero exits", { timeout: 15000 }, async (t) => {
  for (const [name, command] of [
    ["whitespace", "printf '  leading\\ntrailing  \\n\\n'"],
    ["empty", ":"],
    ["stderr", "printf 'err\\n' >&2"],
    ["nonzero", "printf 'out\\n'; exit 7"],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      const expected = await f.native({ command });
      const { result } = await f.invoke({ command });
      assert.deepEqual(comparable(result), comparable(expected));
      assert.equal(result.structuredContent.status, undefined, "foreground shape stays native");
      assert.deepEqual(JSON.parse(textOf(await f.jobs("list"))).jobs, []);
      assert.equal(f.messages.length, 0);
    });
  }
});

test("real native invalid timeout errors remain unchanged", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  for (const timeout of [0, -1, NaN, Infinity, 2147484]) {
    const args = { command: ":", timeout };
    let expected;
    await assert.rejects(f.native(args), (error) => { expected = error.message; return true; });
    await assert.rejects(f.invoke(args), (error) => error.message === expected);
  }
  assert.equal(JSON.parse(textOf(await f.jobs("list"))).total, 0);
});

test("real native output parity: multibyte overflow and 1-MiB structured truncation", { timeout: 20000 }, async (t) => {
  for (const [name, payload, count] of [["multibyte", "界", 25000], ["structured overflow", "x", 1100000]]) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      const args = { command: nodeCommand(`process.stdout.write(${JSON.stringify(payload)}.repeat(${count}))`) };
      const expected = await f.native(args);
      const { result } = await f.invoke(args);
      assert.deepEqual(comparable(result), comparable(expected));
      assert.equal(result.details.truncation.truncated, true);
      const full = await readFile(result.details.fullOutputPath, "utf8");
      assert.deepEqual(digest(full), digest(payload.repeat(count)));
      assert.ok(Buffer.byteLength(textOf(result)) < 53 * 1024);
      assert.ok(!textOf(result).includes("�"), "UTF-8 truncation must not split a codepoint");
      if (name === "structured overflow") {
        assert.equal(result.structuredContent.truncated, true);
        assert.equal(result.structuredContent.full_output_path, result.details.fullOutputPath);
        assert.ok(Buffer.byteLength(result.structuredContent.output) > 1000000);
        assert.ok(Buffer.byteLength(result.structuredContent.output) <= 1024 * 1024 + 1024);
      } else {
        assert.deepEqual(digest(result.structuredContent.output), digest(full));
        assert.equal(result.structuredContent.truncated, false);
      }
    });
  }
});

test("current settings, shell prefix, cwd and native session environment are used on every call", { timeout: 15000 }, async (t) => {
  const settings = { shellPath: "/bin/bash", shellCommandPrefix: "export ASYNC_BASH_FIXTURE=first" };
  const f = await fixture(t, { settings });
  const command = nodeCommand("process.stdout.write(JSON.stringify({prefix:process.env.ASYNC_BASH_FIXTURE,cwd:process.cwd(),session:process.env.PI_SESSION_ID,file:process.env.PI_SESSION_FILE,provider:process.env.PI_PROVIDER,model:process.env.PI_MODEL,thinking:process.env.PI_REASONING_LEVEL}))");
  const { result } = await f.invoke({ command });
  assert.deepEqual(JSON.parse(result.structuredContent.output), {
    prefix: "first", cwd: f.ctx.cwd, session: "fixture-session",
    file: f.ctx.sessionManager.getSessionFile(), provider: "fixture-provider", model: "fixture-model", thinking: "high",
  });
  settings.shellCommandPrefix = "export ASYNC_BASH_FIXTURE=second";
  const next = (await f.invoke({ command })).result;
  assert.equal(JSON.parse(next.structuredContent.output).prefix, "second");
  settings.shellPath = join(f.ctx.cwd, "missing-shell");
  await assert.rejects(f.invoke({ command: ":" }), /shell|ENOENT|exist|found/i);
});

test("explicit background completes exactly once only after its acknowledgement handler returns", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const { result, id } = await f.invoke({ command: "printf 'background complete'", background: true });
  assert.equal(result.structuredContent.status, "running");
  const jobId = result.structuredContent.job_id;
  await until(async () => (await f.status(jobId)).state === "completed", "background command did not complete");
  assert.equal(f.messages.length, 0);
  await f.acknowledge(id, result);
  await f.acknowledge(id, result);
  await until(() => f.messages.length === 1, "missing completion notification");
  await immediate();
  assert.equal(f.messages.length, 1);
  assert.ok(f.timeline.indexOf("send") > f.timeline.indexOf(`ack-end:${id}`));
  const { message, options } = f.messages[0];
  assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
  assert.equal(message.customType, "async_bash_result");
  assert.equal(message.details.job_id, jobId);
  assert.match(textOf(message), /background complete/);
});

test("nested codemode-shaped ids are acknowledged without a nested transcript message", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const { result, id } = await f.invoke({ command: "printf nested", background: true }, { id: "codemode-root/1" });
  await f.acknowledge(id, result, "codemode-root");
  await until(() => f.messages.length === 1, "nested completion was never scheduled");
  assert.ok(f.timeline.indexOf("send") > f.timeline.indexOf(`ack-end:${id}`));
  assert.equal(f.messages[0].message.details.job_id, result.structuredContent.job_id);
  // sendMessage is only collected here. Pi itself queues steer messages until
  // the entire outer tool batch ends; this does not claim to emulate delivery.
});

test("automatic background continues after caller abort and never forwards late updates", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { after: "0.02" });
  const caller = new AbortController();
  const updates = [];
  const { result, id } = await f.invoke({ command: "printf first; sleep 0.15; printf second" }, {
    signal: caller.signal, onUpdate: (value) => updates.push(value),
  });
  assert.equal(result.structuredContent.status, "running");
  const updateCount = updates.length;
  caller.abort();
  await f.acknowledge(id, result);
  await until(() => f.messages.length === 1, "automatic background did not complete");
  assert.equal(f.messages[0].message.details.state, "completed");
  assert.match(textOf(f.messages[0].message), /firstsecond/);
  assert.equal(updates.length, updateCount);
});

test("real foreground cancellation rejects, while explicit background requires bash_jobs cancel", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const caller = new AbortController();
  const pending = f.invoke({ command: "printf started; sleep 3; printf unexpected" }, {
    signal: caller.signal,
    onUpdate: (update) => { if (textOf(update).includes("started")) caller.abort(); },
  });
  await assert.rejects(pending, /Command aborted/);
  assert.equal(f.messages.length, 0);

  const backgroundCaller = new AbortController();
  const { result, id } = await f.invoke({ command: "printf started; sleep 3; printf unexpected", background: true }, { signal: backgroundCaller.signal });
  const jobId = result.structuredContent.job_id;
  await f.acknowledge(id, result);
  backgroundCaller.abort();
  await delay(20);
  assert.equal((await f.status(jobId)).state, "running");
  await f.jobs("cancel", jobId);
  await until(() => f.messages.length === 1, "cancel did not finish");
  assert.equal((await f.status(jobId)).state, "cancelled");
  assert.doesNotMatch(textOf(f.messages[0].message).split("\n").slice(1).join("\n"), /unexpected/);
  await f.jobs("cancel", jobId);
  await immediate();
  assert.equal(f.messages.length, 1);
});

test("cancellation uses native process-group cleanup, including shell children", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const marker = join(f.ctx.cwd, "escaped-child.txt");
  const { result, id } = await f.invoke({
    command: `printf ready; (sleep 0.2; printf escaped > ${quote(marker)}) & wait`, background: true,
  });
  const jobId = result.structuredContent.job_id;
  await f.acknowledge(id, result);
  await until(async () => textOf(await f.jobs("status", jobId)).split("\n").slice(1).join("\n").includes("ready"), "child fixture never started");
  await f.jobs("cancel", jobId);
  await until(() => f.messages.length === 1, "process-group cancellation did not settle");
  assert.equal((await f.status(jobId)).state, "cancelled");
  await delay(250);
  await assert.rejects(stat(marker), { code: "ENOENT" });
});

test("background native timeout is failed and retains its full-output file", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const { result, id } = await f.invoke({
    command: nodeCommand("process.stdout.write('z'.repeat(80000)); setTimeout(() => {}, 3000)"),
    timeout: 0.4, background: true,
  });
  await f.acknowledge(id, result);
  await until(() => f.messages.length === 1, "native timeout did not finish");
  const status = await f.status(result.structuredContent.job_id);
  assert.equal(status.state, "failed");
  assert.match(textOf(f.messages[0].message), /Command timed out after 0.4 seconds/);
  assert.ok((await stat(status.full_output_path)).size >= 80000);
});

test("shutdown/replacement/reload cancel and suppress jobs; completed tree navigation starts a fresh pool", { timeout: 20000 }, async (t) => {
  for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
    await t.test(reason, async (t) => {
      const f = await fixture(t);
      const { result, id } = await f.invoke({ command: "sleep 2", background: true });
      await f.acknowledge(id, result);
      await f.emit("session_shutdown", { reason });
      await immediate();
      assert.equal(f.messages.length, 0);
      assert.equal(JSON.parse(textOf(await f.jobs("list"))).total, 0);
      await assert.rejects(f.jobs("status", result.structuredContent.job_id), /Unknown job/);
    });
  }
  await t.test("tree generation", async (t) => {
    const f = await fixture(t);
    const old = await f.invoke({ command: "sleep 2", background: true });
    await f.acknowledge(old.id, old.result);
    await f.emit("session_before_tree", {
      preparation: { targetId: "new", oldLeafId: "old", commonAncestorId: null, entriesToSummarize: [], userWantsSummary: false },
      signal: new AbortController().signal,
    });
    await f.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
    const fresh = await f.invoke({ command: "printf fresh", background: true });
    await f.acknowledge(fresh.id, fresh.result);
    await until(() => f.messages.length === 1, "new branch job did not complete");
    assert.equal(f.messages[0].message.details.job_id, fresh.result.structuredContent.job_id);
    await assert.rejects(f.jobs("status", old.result.structuredContent.job_id), /Unknown job/);
  });
});

test("public schemas keep native foreground output and require job IDs for status/cancel", async (t) => {
  const f = await fixture(t);
  const native = createBashToolDefinition(f.ctx.cwd);
  const bash = f.tools.get("bash");
  assert.equal(bash.parameters.type, "object");
  assert.deepEqual(bash.parameters.properties.command, native.parameters.properties.command);
  assert.deepEqual(bash.parameters.properties.timeout, native.parameters.properties.timeout);
  assert.equal(bash.parameters.properties.background.type, "boolean");
  assert.ok(bash.outputSchema.anyOf.some((schema) => JSON.stringify(schema) === JSON.stringify(native.outputSchema)));
  assert.ok(bash.outputSchema.anyOf.some((schema) => schema.properties?.status?.const === "running"));
  assert.equal(typeof bash.renderCall, "function");
  assert.equal(typeof bash.renderResult, "function");
  assert.match(f.tools.get("bash_jobs").promptSnippet, /List, inspect, or cancel/);
  assert.equal(f.tools.get("bash_jobs").parameters.type, "object");
  assert.equal(f.tools.get("bash_jobs").parameters.anyOf, undefined);
  const actionSchema = f.tools.get("bash_jobs").parameters.properties.action;
  // Pi's HTML tool list only displays type and description, not anyOf branches.
  assert.equal(actionSchema.type, "string");
  assert.deepEqual(actionSchema.anyOf.map((choice) => choice.const), ["list", "status", "cancel"]);
  for (const choice of ["list", "status", "cancel"]) assert.ok(actionSchema.description.includes(`"${choice}"`));
  for (const action of ["status", "cancel"]) {
    await assert.rejects(f.jobs(action), /job_id is required/);
    await assert.rejects(f.jobs(action, ""), /job_id is required/);
    await assert.rejects(f.jobs(action, "unknown"), /Unknown job/);
  }
});

test("configuration rejects invalid thresholds before execution", async (t) => {
  const f = await fixture(t);
  for (const value of ["", "oops", "-1", "Infinity", "2147484"]) {
    f.flags.set("bash-background-after", value);
    await assert.rejects(f.emit("session_start"), /bash-background-after/);
    await assert.rejects(f.invoke({ command: ":" }), /bash-background-after/);
    assert.equal(JSON.parse(textOf(await f.jobs("list"))).total, 0);
  }
  f.flags.set("bash-background-after", "0");
  assert.equal((await f.invoke({ command: ":" })).result.structuredContent.exit_code, 0);
});

test("before-switch and before-fork cancel old work even when navigation is vetoed", { timeout: 15000 }, async (t) => {
  for (const [event, fields] of [
    ["session_before_switch", { reason: "resume", targetSessionFile: "fixture-target.jsonl" }],
    ["session_before_fork", { entryId: "fixture-entry", position: "at" }],
  ]) {
    await t.test(event, async (t) => {
      const f = await fixture(t);
      const old = await f.invoke({ command: "sleep 2", background: true });
      await f.acknowledge(old.id, old.result);
      await f.emit(event, fields);
      // Deliberately no shutdown/start: a later handler vetoed navigation.
      assert.equal(JSON.parse(textOf(await f.jobs("list"))).total, 0);
      await assert.rejects(f.jobs("status", old.result.structuredContent.job_id), /Unknown job/);
      const fresh = await f.invoke({ command: "printf new-work", background: true });
      await f.acknowledge(fresh.id, fresh.result);
      await until(() => f.messages.length === 1, "pool did not reopen after navigation attempt");
      assert.equal(f.messages[0].message.details.job_id, fresh.result.structuredContent.job_id);
    });
  }
});

test("explicit and automatic background execute the command only once", { timeout: 15000 }, async (t) => {
  for (const background of [true, false]) {
    await t.test(background ? "explicit" : "automatic", async (t) => {
      const f = await fixture(t, { after: "0.01" });
      const marker = join(f.ctx.cwd, "executions.txt");
      const { result, id } = await f.invoke({ command: `printf 'once\\n' >> ${quote(marker)}; sleep 0.08; printf finished`, background });
      assert.equal(result.structuredContent.status, "running");
      await f.acknowledge(id, result);
      await until(() => f.messages.length === 1, "completion missing");
      assert.equal(await readFile(marker, "utf8"), "once\n");
      await immediate();
      assert.equal(f.messages.length, 1);
    });
  }
});

test("native line truncation and background nonzero status retain the official log", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const { result, id } = await f.invoke({
    command: `${nodeCommand("process.stdout.write('line\\n'.repeat(2500))")}; exit 23`, background: true,
  });
  await f.acknowledge(id, result);
  await until(() => f.messages.length === 1, "nonzero completion missing");
  const jobId = result.structuredContent.job_id;
  const status = await f.status(jobId);
  assert.equal(status.state, "failed");
  assert.equal(status.exit_code, 23);
  assert.equal((await readFile(status.full_output_path, "utf8")).split("\n").length, 2501);
  const details = await f.jobs("status", jobId);
  assert.match(textOf(details), /Command exited with code 23/);
  assert.ok(textOf(details).length < 15000);
});

test("tree navigation suppresses old completions while branch preparation is still pending", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const { result, id } = await f.invoke({ command: "sleep 0.08; printf obsolete", background: true });
  await f.acknowledge(id, result);
  await f.emit("session_before_tree", {
    preparation: { targetId: "new", oldLeafId: "old", commonAncestorId: null, entriesToSummarize: [], userWantsSummary: true },
    signal: new AbortController().signal,
  });
  // This is the interval occupied by asynchronous branch summarization in Pi.
  await delay(180);
  assert.equal(f.messages.length, 0, "old completion must not start an agent run during navigation");
  await f.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
});
