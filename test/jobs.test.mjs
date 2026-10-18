import assert from "node:assert/strict";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JobPool } from "../src/jobs.ts";

const result = (text = "done", extra = {}) => ({
  content: [{ type: "text", text }], details: undefined, ...extra,
});

function controlled() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  let ownedSignal;
  let update;
  return {
    resolve, reject,
    get signal() { return ownedSignal; },
    update(value) { update(value); },
    execute(signal, onUpdate) {
      ownedSignal = signal;
      update = onUpdate;
      if (signal.aborted) reject(new Error("Command aborted"));
      else signal.addEventListener("abort", () => reject(new Error("Command aborted")), { once: true });
      return promise;
    },
  };
}

function setup(t) {
  const notifications = [];
  const pool = new JobPool((job) => notifications.push({ id: job.id, state: job.state }));
  t.after(() => pool.stop());
  let counter = 0;
  const run = (execute, overrides = {}) => pool.run({
    toolCallId: `call-${++counter}`, command: "test command", background: false,
    afterSeconds: 0, execute, ...overrides,
  });
  return { pool, notifications, run };
}

async function settled(job) {
  for (let i = 0; i < 100 && !job.endedAt; i++) await immediate();
  assert.ok(job.endedAt, "controlled execution must settle");
}

// These scheduler tests deliberately use small, controllable promises. The other
// test file exercises the actual public Pi bash factory; no private API is copied.
test("foreground preserves the exact native result object and is not retained", async (t) => {
  const { pool, notifications, run } = setup(t);
  const native = result(" \n", { structuredContent: { output: " \n", exit_code: 0 } });
  const outcome = await run(async () => native);
  assert.strictEqual(outcome.result, native);
  assert.deepEqual(pool.list(), []);
  await immediate();
  assert.deepEqual(notifications, []);
});

test("foreground failures reject unchanged and are not retained", async (t) => {
  const { pool, notifications, run } = setup(t);
  const error = new Error("native failure");
  await assert.rejects(run(async () => { throw error; }), (actual) => actual === error);
  assert.deepEqual(pool.list(), []);
  assert.deepEqual(notifications, []);
});

test("instant explicit completion waits for acknowledgement; duplicate acknowledgements notify once", async (t) => {
  const { pool, notifications, run } = setup(t);
  const { job } = await run(async () => result(), { background: true, toolCallId: "instant" });
  await settled(job);
  await immediate();
  assert.deepEqual(notifications, []);
  pool.acknowledge("unrelated");
  pool.acknowledge("instant");
  pool.acknowledge("instant");
  assert.deepEqual(notifications, [], "notification must not run inside acknowledgement handler");
  await immediate();
  assert.deepEqual(notifications, [{ id: job.id, state: "completed" }]);
  pool.acknowledge("instant");
  await immediate();
  assert.equal(notifications.length, 1);
});

test("automatic backgrounding forwards only foreground updates and detaches caller abort", async (t) => {
  const { pool, notifications, run } = setup(t);
  const execution = controlled();
  const caller = new AbortController();
  const updates = [];
  const pending = run(execution.execute, {
    toolCallId: "automatic", afterSeconds: 0.015, signal: caller.signal,
    onUpdate: (update) => updates.push(update),
  });
  await Promise.resolve();
  const before = result("before");
  execution.update(before);
  const { job } = await pending;
  assert.ok(job?.background);
  pool.acknowledge("automatic");
  caller.abort();
  assert.equal(execution.signal.aborted, false);
  const after = result("after");
  execution.update(after);
  assert.deepEqual(updates, [before]);
  assert.deepEqual(job.snapshot.content, after.content);
  execution.resolve(result("final"));
  await settled(job);
  await immediate();
  assert.equal(notifications.length, 1);
});

test("explicit background ignores subsequent caller abort but cancel owns the native signal", async (t) => {
  const { pool, notifications, run } = setup(t);
  const execution = controlled();
  const caller = new AbortController();
  const { job } = await run(execution.execute, {
    toolCallId: "owned", background: true, signal: caller.signal,
  });
  caller.abort();
  assert.equal(execution.signal.aborted, false);
  pool.acknowledge("owned");
  assert.strictEqual(pool.cancel(job.id), job);
  assert.equal(execution.signal.aborted, true);
  await settled(job);
  await immediate();
  assert.equal(job.state, "cancelled");
  assert.equal(notifications.length, 1);
  pool.cancel(job.id);
  await immediate();
  assert.equal(notifications.length, 1);
});

test("foreground cancellation reaches native signal, including pre-aborted explicit calls", async (t) => {
  const { pool, run } = setup(t);
  const execution = controlled();
  const caller = new AbortController();
  const pending = run(execution.execute, { signal: caller.signal });
  await Promise.resolve();
  caller.abort();
  await assert.rejects(pending, /Command aborted/);
  assert.equal(execution.signal.aborted, true);
  await assert.rejects(run(controlled().execute, { background: true, signal: caller.signal }), /Command aborted/);
  assert.equal(pool.list().length, 0);
});

test("foreground abort cannot turn into a background acknowledgement during native cancellation cleanup", async (t) => {
  const { pool, run } = setup(t);
  const caller = new AbortController();
  const pending = run(async (signal) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    // Native cleanup may be asynchronous: the threshold must not win after abort.
    await delay(35);
    throw new Error("Command aborted");
  }, { signal: caller.signal, afterSeconds: 0.015 });
  await Promise.resolve();
  caller.abort();
  await assert.rejects(pending, /Command aborted/);
  assert.equal(pool.list().length, 0);
});

test("failed results, thrown errors, exit codes and last native log details survive projection", async (t) => {
  const { pool, notifications, run } = setup(t);
  const bad = await run(async () => result("exit 9", {
    isError: true, structuredContent: { exit_code: 9, output: "x".repeat(1024 * 1024) },
  }), { toolCallId: "nonzero", background: true });
  pool.acknowledge("nonzero");
  await settled(bad.job);
  assert.equal(bad.job.state, "failed");
  assert.equal(bad.job.exitCode, 9);
  assert.equal(bad.job.snapshot.structuredContent, undefined);

  const execution = controlled();
  const { job } = await run(execution.execute, { toolCallId: "timeout", background: true });
  execution.update(result("tail", { details: { fullOutputPath: "/tmp/native-log-fixture" } }));
  pool.acknowledge("timeout");
  execution.reject(new Error("Command timed out after 2 seconds"));
  await settled(job);
  await immediate();
  assert.equal(job.state, "failed");
  assert.equal(job.snapshot.details.fullOutputPath, "/tmp/native-log-fixture");
  assert.match(job.snapshot.content[0].text, /timed out/);
  assert.equal(notifications.length, 2);
});

test("stop cancels work, suppresses scheduled completions, clears state and permits a fresh generation", async (t) => {
  const { pool, notifications, run } = setup(t);
  const instant = await run(async () => result(), { toolCallId: "old", background: true });
  await settled(instant.job);
  pool.acknowledge("old");
  const execution = controlled();
  const pending = await run(execution.execute, { toolCallId: "pending", background: true });
  pool.acknowledge("pending");
  await pool.stop();
  assert.equal(execution.signal.aborted, true);
  assert.equal(pending.job.state, "cancelled");
  assert.deepEqual(pool.list(), []);
  await assert.rejects(run(async () => result()), /shutting down/);
  pool.start();
  await immediate();
  assert.deepEqual(notifications, []);
  const fresh = await run(async () => result(), { toolCallId: "new", background: true });
  pool.acknowledge("new");
  await settled(fresh.job);
  await immediate();
  assert.deepEqual(notifications, [{ id: fresh.job.id, state: "completed" }]);
  await pool.stop();
  await pool.stop();
});

test("terminal retention is bounded and running jobs are never pruned", async (t) => {
  const { pool, run } = setup(t);
  const execution = controlled();
  const running = await run(execution.execute, { background: true, toolCallId: "keep-running" });
  const ids = [];
  for (let i = 0; i < 27; i++) {
    const { job } = await run(async () => result(), { background: true, toolCallId: `retention-${i}` });
    pool.acknowledge(job.toolCallId);
    await settled(job);
    ids.push(job.id);
  }
  await immediate();
  assert.equal(pool.list().filter((job) => job.endedAt).length, 20);
  assert.strictEqual(pool.get(running.job.id), running.job);
  assert.throws(() => pool.get(ids[0]), /Unknown job/);
  assert.throws(() => pool.cancel("not-a-job"), /Unknown job/);
});

test("late acknowledgements also enforce the terminal retention bound", async (t) => {
  const { pool, run } = setup(t);
  const completed = [];
  for (let i = 0; i < 27; i++) {
    const { job } = await run(async () => result(), { background: true, toolCallId: `late-${i}` });
    await settled(job);
    completed.push(job);
  }
  for (const job of completed) pool.acknowledge(job.toolCallId);
  await immediate();
  assert.ok(pool.list().length <= 20, `late acknowledgements retained ${pool.list().length} completed jobs`);
});
