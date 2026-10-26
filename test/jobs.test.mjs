import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
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

function setup(t, { confirm = true } = {}) {
  const notifications = [];
  const pool = new JobPool((job) => {
    notifications.push({ id: job.id, state: job.state });
    if (confirm) {
      pool.observeDelivery(job.id); // Simulate actual consumption, not enqueue alone.
      pool.reconcileNotifications(new Set(), false); // Completed turn boundary.
    }
  });
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
test("job IDs are short lowercase hex and remain usable for lookup and cancellation", async (t) => {
  const { pool, run } = setup(t);
  const { job } = await run(controlled().execute, { background: true });
  assert.match(job.id, /^bg-[0-9a-f]{8}$/);
  assert.strictEqual(pool.get(job.id), job);
  assert.strictEqual(pool.cancel(job.id), job);
  await settled(job);
  assert.equal(job.state, "cancelled");
});

test("ID collisions retry without replacing running or retained completed jobs", async (t) => {
  const ids = ["12345678", "12345678", "abcdef01", "abcdef01", "12345678", "00000000"];
  let calls = 0;
  const random = t.mock.method(crypto, "randomBytes", (size) => {
    assert.equal(size, 4);
    assert.ok(calls < ids.length, "unexpected extra ID generation");
    return Buffer.from(ids[calls++], "hex");
  });
  syncBuiltinESMExports();
  t.after(() => { random.mock.restore(); syncBuiltinESMExports(); });
  const { pool, run } = setup(t);
  const first = await run(controlled().execute, { background: true });
  const second = await run(async () => result(), { background: true });
  await settled(second.job);
  const third = await run(controlled().execute, { background: true });
  assert.deepEqual([first.job.id, second.job.id, third.job.id], [
    "bg-12345678", "bg-abcdef01", "bg-00000000",
  ]);
  assert.equal(calls, ids.length);
  for (const { job } of [first, second, third]) assert.strictEqual(pool.get(job.id), job);
});

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

test("enqueue is not delivery; a cleared notification is resent once after abort settles", async (t) => {
  const { pool, notifications, run } = setup(t, { confirm: false });
  const { job } = await run(async () => result(), { background: true, toolCallId: "clear-queue" });
  pool.acknowledge(job.toolCallId);
  await settled(job);
  await immediate();
  assert.equal(job.delivery, "queued");
  assert.equal(notifications.length, 1);
  pool.reconcileNotifications(new Set([job.id]), true);
  assert.equal(notifications.length, 1, "still queued must not be enqueued twice");
  pool.retryPendingNotifications();
  await immediate();
  assert.equal(notifications.length, 1, "settlement must not resend a notification still queued");
  pool.reconcileNotifications(new Set(), false);
  assert.equal(job.delivery, "pending");
  assert.equal(notifications.length, 1, "must not restart the run while it is still aborting");
  pool.retryPendingNotifications();
  pool.retryPendingNotifications();
  assert.equal(job.delivery, "scheduled");
  assert.equal(notifications.length, 1);
  await immediate();
  assert.equal(job.delivery, "queued");
  assert.equal(notifications.length, 2);
  pool.observeDelivery(job.id);
  assert.equal(job.delivery, "consumed");
  pool.reconcileNotifications(new Set(), true);
  assert.equal(job.delivery, "delivered");
  pool.acknowledge(job.toolCallId);
  pool.retryPendingNotifications();
  await immediate();
  assert.equal(notifications.length, 2, "confirmed results are never replayed");
});

test("results hidden behind a one-at-a-time queue head are not resent", async (t) => {
  const { pool, notifications, run } = setup(t, { confirm: false });
  const jobs = [];
  for (let i = 0; i < 3; i++) {
    const { job } = await run(async () => result(), { background: true });
    pool.acknowledge(job.toolCallId);
    await settled(job);
    jobs.push(job);
  }
  await immediate();
  assert.equal(notifications.length, 3);
  for (const [index, job] of jobs.entries()) {
    // Pi's turn_end snapshot shows only the next queued message.
    pool.reconcileNotifications(new Set([job.id]), true, false);
    assert.equal(notifications.length, 3, `turn ${index + 1} must not replay messages still behind the head`);
    pool.observeDelivery(job.id);
  }
  pool.reconcileNotifications(new Set(), true);
  assert.ok(jobs.every((job) => job.delivery === "delivered"));
  assert.equal(notifications.length, 3);
});

test("undelivered completions are not pruned even after more than twenty jobs finish", async (t) => {
  const { pool, run } = setup(t, { confirm: false });
  const ids = [];
  for (let i = 0; i < 25; i++) {
    const { job } = await run(async () => result(), { background: true });
    pool.acknowledge(job.toolCallId);
    await settled(job);
    ids.push(job.id);
  }
  await immediate();
  assert.equal(pool.list().length, 25);
  assert.ok(pool.list().every((job) => job.delivery === "queued"));
  for (const id of ids) pool.observeDelivery(id);
  pool.reconcileNotifications(new Set(), false);
  assert.equal(pool.list().length, 20);
});

test("a scheduled initial send cannot be duplicated by reconciliation", async (t) => {
  const { pool, notifications, run } = setup(t, { confirm: false });
  const { job } = await run(async () => result(), { background: true });
  await settled(job);
  pool.acknowledge(job.toolCallId);
  assert.equal(job.delivery, "scheduled");
  pool.reconcileNotifications(new Set(), true);
  assert.equal(notifications.length, 0);
  await immediate();
  assert.equal(notifications.length, 1);
});

test("an enqueue failure keeps the result pending and permits later recovery", async (t) => {
  let attempts = 0;
  const pool = new JobPool(() => { if (++attempts === 1) throw new Error("send failed"); });
  t.after(() => pool.stop());
  const { job } = await pool.run({ toolCallId: "send-fails", command: ":", background: true, afterSeconds: 0, execute: async () => result() });
  pool.acknowledge(job.toolCallId);
  await settled(job);
  await immediate();
  assert.equal(job.delivery, "pending");
  pool.reconcileNotifications(new Set(), true);
  assert.equal(attempts, 2);
  assert.equal(job.delivery, "queued");
});

test("consumption survives missing end metadata and is confirmed even on an aborted boundary", async (t) => {
  const { pool, notifications, run } = setup(t, { confirm: false });
  const { job } = await run(async () => result(), { background: true });
  pool.acknowledge(job.toolCallId);
  await settled(job);
  await immediate();
  pool.observeDelivery(job.id);
  // A preceding extension can erase customType/details from message_end. There
  // is intentionally no end-message ID passed to the pool or needed for recovery.
  pool.acknowledge(job.toolCallId);
  await immediate();
  assert.equal(job.delivery, "consumed");
  assert.equal(notifications.length, 1);
  pool.retryPendingNotifications();
  await immediate();
  assert.equal(notifications.length, 1, "consumed messages must not be resent after abort");
  pool.reconcileNotifications(new Set(), false);
  assert.equal(job.delivery, "delivered");
  pool.reconcileNotifications(new Set(), true);
  assert.equal(notifications.length, 1);
});

test("each later cleared attempt can recover once without rerunning the command", async (t) => {
  const { pool, notifications, run } = setup(t, { confirm: false });
  let executions = 0;
  const { job } = await run(async () => { executions++; return result(); }, { background: true });
  pool.acknowledge(job.toolCallId);
  await settled(job);
  await immediate();
  for (let attempt = 1; attempt <= 3; attempt++) {
    pool.reconcileNotifications(new Set(), false);
    pool.retryPendingNotifications();
    pool.retryPendingNotifications();
    await immediate();
    assert.equal(notifications.length, attempt + 1);
  }
  assert.equal(executions, 1);
});

test("shutdown suppresses recovery scheduled at aborted settlement", async (t) => {
  const { pool, notifications, run } = setup(t, { confirm: false });
  const { job } = await run(async () => result(), { background: true });
  pool.acknowledge(job.toolCallId);
  await settled(job);
  await immediate();
  pool.reconcileNotifications(new Set(), false);
  pool.retryPendingNotifications();
  await pool.stop();
  pool.retryPendingNotifications();
  pool.start();
  await immediate();
  assert.equal(notifications.length, 1);
  assert.deepEqual(pool.list(), []);
});
