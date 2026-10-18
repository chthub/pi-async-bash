import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import asyncBash from "../src/index.ts";
import { attachJobWidget, renderJobRows } from "../src/widget.ts";

const plainTheme = { fg: (_token, text) => text };
const now = 1_000_000;
const job = (overrides = {}) => ({ id: "bg-12345678-1234", command: "printf widget-fixture", startedAt: now - 1500, state: "running", ...overrides });
const plain = (lines) => lines.map(stripTerminalSequences);

// Only the widget's interval is substituted. No global Date/setTimeout mocking,
// no real waiting for its 1s clock, and no private Pi UI implementation imported.
function fakeIntervals(t) {
  let sequence = 0;
  const active = new Map();
  const created = [];
  const cleared = [];
  t.mock.method(globalThis, "setInterval", (callback, milliseconds) => {
    const handle = { id: ++sequence, unrefs: 0, unref() { this.unrefs++; } };
    const interval = { callback, milliseconds, handle };
    active.set(handle, interval);
    created.push(interval);
    return handle;
  });
  t.mock.method(globalThis, "clearInterval", (handle) => {
    cleared.push(handle);
    active.delete(handle);
  });
  return {
    active, created, cleared,
    tick() { for (const { callback } of [...active.values()]) callback(); },
  };
}

function uiFixture(theme = plainTheme) {
  const calls = [];
  let component;
  let renders = 0;
  const tui = { requestRender() { renders++; } };
  const ui = {
    setWidget(key, factory, options) {
      calls.push({ key, factory, options });
      if (factory) component = factory(tui, theme);
      else component = undefined;
    },
  };
  return { ui, tui, calls, get component() { return component; }, get renders() { return renders; } };
}

test("widget renders only pending jobs, at most three rows plus header/more", () => {
  const jobs = Object.freeze([
    Object.freeze(job({ id: "bg-one", command: "first-command" })),
    Object.freeze(job({ id: "bg-two", command: "second-command", state: "cancelling" })),
    Object.freeze(job({ id: "bg-three", command: "third-command" })),
    Object.freeze(job({ id: "bg-four", command: "hidden-fourth" })),
    Object.freeze(job({ id: "bg-five", command: "hidden-fifth" })),
    Object.freeze(job({ id: "done", command: "hidden-done", state: "completed", endedAt: now })),
    Object.freeze(job({ id: "failed", command: "hidden-failed", state: "failed" })),
    Object.freeze(job({ id: "cancelled", command: "hidden-cancelled", state: "cancelled" })),
    Object.freeze(job({ id: "ended-zero", command: "hidden-ended-zero", endedAt: 0 })),
  ]);
  const before = JSON.stringify(jobs);
  const rows = renderJobRows(jobs, 120, plainTheme, now);
  assert.equal(rows.length, 5);
  assert.match(rows[0], /5 active/);
  assert.match(rows[1], /first-command/);
  assert.match(rows[2], /cancelling.*second-command/);
  assert.match(rows[3], /third-command/);
  assert.match(rows[4], /\+2 more/);
  assert.doesNotMatch(rows.join("\n"), /hidden-/);
  assert.equal(JSON.stringify(jobs), before, "rendering must not mutate job state or commands");
  assert.deepEqual(renderJobRows([], 80, plainTheme, now), []);
  for (const state of ["completed", "failed", "cancelled"]) {
    assert.deepEqual(renderJobRows([job({ state })], 80, plainTheme, now), []);
  }
});

test("renderer needs only a readonly job view, never output snapshots or cancellation handles", () => {
  const input = Object.freeze({
    ...job(),
    get snapshot() { assert.fail("UI inspected native output"); },
    get controller() { assert.fail("UI accessed execution controls"); },
  });
  assert.equal(renderJobRows([input], 80, plainTheme, now).length, 2);
});

test("widget respects terminal columns at narrow widths with CJK, combining marks and emoji", () => {
  const themed = { fg: (_token, text) => `\x1b[32m${text}\x1b[0m` };
  const command = "中文命令 👩‍💻 🚀 e\u0301 🏳️‍🌈 文件路径/结果";
  const jobs = [job({ command }), job({ command, state: "cancelling" }), job({ command }), job({ command })];
  for (const width of [-1, 0, 1, 2, 3, 5, 11, 20, 31, 40, 80, 160]) {
    const rows = renderJobRows(jobs, width, themed, now);
    if (width <= 0) assert.deepEqual(rows, []);
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= width, `row exceeds ${width} terminal columns: ${JSON.stringify(row)}`);
      assert.doesNotMatch(row, /[\r\n]/);
      assert.doesNotMatch(row, /\ufffd/, "rendering must not introduce replacement characters");
      assert.equal(row.isWellFormed(), true, "truncation must not leave a lone surrogate");
    }
  }
  const wide = plain(renderJobRows(jobs, 160, themed, now));
  assert.ok(wide[1].includes(command), "an untruncated preview must preserve composed emoji and combining text");
});

test("command previews remove injected ANSI, OSC, controls and bidi overrides without changing commands", () => {
  const command = "printf\t\x1b[31m红色\x1b[0m\r\n"
    + "\x1b[2J\x1b]52;c;SECRET_CLIPBOARD\x07"
    + "\x1b]8;;https://injected.example/\x1b\\link\x1b]8;;\x1b\\ "
    + "\x00\x07\x1b\x7f\x85\u202e\u2066safe\u2069";
  const input = Object.freeze(job({ command }));
  const rows = renderJobRows([input], 250, plainTheme, now);
  const preview = rows[1];
  assert.match(preview, /printf 红色/);
  assert.match(preview, /link.*safe/);
  assert.doesNotMatch(preview, /SECRET_CLIPBOARD|injected\.example/);
  assert.doesNotMatch(preview, /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
  assert.equal(input.command, command);
});

test("elapsed labels clamp negative time and format seconds, minutes and hours; cancellation has warning color", () => {
  const calls = [];
  const theme = { fg(token, text) { calls.push({ token, text }); return text; } };
  for (const [milliseconds, label] of [[-1000, "0s"], [0, "0s"], [59_999, "59s"], [60_000, "1m 0s"], [3_599_999, "59m 59s"], [3_600_000, "1h 0m"], [7_320_000, "2h 2m"]]) {
    const rows = renderJobRows([job({ startedAt: now - milliseconds })], 120, theme, now);
    assert.ok(rows[1].includes(`running ${label} `), `${milliseconds} should display ${label}`);
  }
  renderJobRows([job({ state: "cancelling" })], 120, theme, now);
  assert.ok(calls.some(({ token, text }) => token === "warning" && text.includes("cancelling")));
  assert.ok(calls.some(({ token, text }) => token === "accent" && text.includes("running")));
  assert.ok(calls.some(({ token, text }) => token === "muted" && text.includes("Background bash")));
});

test("widget attaches below the editor, refreshes every 1s, and does not pollute the footer", (t) => {
  const clock = fakeIntervals(t);
  const f = uiFixture();
  let jobs = [];
  let reads = 0;
  const dispose = attachJobWidget({ mode: "tui", ui: f.ui }, () => { reads++; return jobs; });
  t.after(dispose);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].key, "async-bash-jobs");
  assert.deepEqual(f.calls[0].options, { placement: "belowEditor" });
  assert.equal(clock.active.size, 1);
  assert.equal(clock.created[0].milliseconds, 1000);
  assert.equal(clock.created[0].handle.unrefs, 1, "a UI timer must not keep the process alive");
  assert.deepEqual(f.component.render(80), []);
  clock.tick();
  assert.equal(f.renders, 0, "idle jobs should not request redraws");
  jobs = [job()];
  clock.tick();
  assert.equal(f.renders, 1);
  assert.equal(f.component.render(80).length, 2);
  clock.tick();
  assert.equal(f.renders, 2, "elapsed time must refresh without job output updates");
  jobs = [job({ state: "completed", endedAt: now })];
  clock.tick();
  assert.equal(f.renders, 3, "one final redraw must clear the completed job");
  assert.deepEqual(f.component.render(80), []);
  clock.tick();
  assert.equal(f.renders, 3);
  assert.ok(reads >= 5);
  dispose();
  dispose();
  assert.equal(clock.active.size, 0);
  assert.equal(f.calls.filter(({ factory }) => factory === undefined).length, 1);
  const readsAfterDispose = reads;
  clock.tick();
  assert.equal(reads, readsAfterDispose);
});

test("rendering reads current data and theme on every render/invalidate, including resize", (t) => {
  fakeIntervals(t);
  let color = "31";
  const theme = { fg: (_token, text) => `\x1b[${color}m${text}\x1b[0m` };
  const f = uiFixture(theme);
  let jobs = [job({ command: "old-command" })];
  const dispose = attachJobWidget({ mode: "tui", ui: f.ui }, () => jobs);
  t.after(dispose);
  assert.ok(f.component.render(100)[1].includes("\x1b[31m"));
  color = "34";
  jobs = [job({ command: "新命令 🚀" })];
  f.component.invalidate();
  const refreshed = f.component.render(100);
  assert.ok(refreshed[1].includes("\x1b[34m"));
  assert.ok(stripTerminalSequences(refreshed[1]).includes("新命令 🚀"));
  assert.doesNotMatch(refreshed.join("\n"), /old-command|\x1b\[31m/);
  for (const row of f.component.render(7)) assert.ok(visibleWidth(row) <= 7);
});

test("factory recreation disposes the old interval and uses the new injected theme", (t) => {
  const clock = fakeIntervals(t);
  const f = uiFixture();
  const dispose = attachJobWidget({ mode: "tui", ui: f.ui }, () => [job()]);
  t.after(dispose);
  const firstHandle = clock.created[0].handle;
  const factory = f.calls[0].factory;
  const replacement = factory(f.tui, { fg: (_token, text) => `\x1b[35m${text}\x1b[0m` });
  assert.equal(clock.active.size, 1);
  assert.equal(clock.active.has(firstHandle), false);
  assert.ok(clock.cleared.includes(firstHandle));
  assert.ok(replacement.render(80)[1].includes("\x1b[35m"));
  dispose();
  assert.equal(clock.active.size, 0);
});

test("dispose and re-attach leave one live timer, with idempotent component disposal", (t) => {
  const clock = fakeIntervals(t);
  const f = uiFixture();
  const ctx = { mode: "tui", ui: f.ui };
  const first = attachJobWidget(ctx, () => [job()]);
  t.after(first);
  const oldComponent = f.component;
  first();
  const second = attachJobWidget(ctx, () => [job({ command: "new-attachment" })]);
  t.after(second);
  assert.equal(clock.active.size, 1);
  first();
  oldComponent.dispose();
  oldComponent.dispose();
  assert.equal(clock.active.size, 1, "disposing an old component must not stop its replacement");
  assert.match(plain(f.component.render(100))[1], /new-attachment/);
  second();
  assert.equal(clock.active.size, 0);
});

test("non-TUI modes perform zero UI calls, timer creation or job reads", (t) => {
  const clock = fakeIntervals(t);
  let reads = 0;
  const ui = new Proxy({}, { get() { assert.fail("non-TUI code accessed ui"); } });
  for (const mode of ["rpc", "json", "print", undefined]) {
    const dispose = attachJobWidget({ mode, ui }, () => { reads++; return [job()]; });
    dispose();
    dispose();
  }
  assert.equal(clock.created.length, 0);
  assert.equal(reads, 0);
});

async function extensionFixture(t, mode = "tui") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-async-bash-widget-test-"));
  const clock = fakeIntervals(t);
  const f = uiFixture();
  const handlers = new Map();
  const tools = new Map();
  const messages = [];
  const ctx = { mode, cwd, ui: f.ui, sessionManager: { getSessionId: () => "widget-session", getSessionFile: () => undefined } };
  const api = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerFlag() {},
    getFlag() { return "0"; },
    getSettings() { return {}; },
    sendMessage(message, options) { messages.push({ message, options }); },
    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {};
    },
  };
  asyncBash(api);
  assert.equal(clock.created.length, 0, "extension factory must not start UI timers");
  assert.equal(f.calls.length, 0, "extension factory must not install UI before session_start");
  const emit = async (type, fields = {}) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...fields }, ctx);
  };
  t.after(async () => {
    await emit("session_shutdown", { reason: "quit" });
    await rm(cwd, { recursive: true, force: true });
  });
  const jobs = (action, job_id) => tools.get("bash_jobs").execute("inspect", { action, job_id }, undefined, undefined, ctx);
  await emit("session_start", { reason: "startup" });
  return { ...f, uiFixture: f, clock, tools, messages, ctx, emit, jobs };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail("widget integration fixture did not settle");
}

test("extension wiring starts no UI before session_start and cleans up the widget on shutdown", { timeout: 10000 }, async (t) => {
  const f = await extensionFixture(t);
  assert.ok(f.uiFixture.component, "session_start must attach the job widget in TUI mode");
  assert.equal(f.clock.active.size, 1);
  assert.deepEqual(f.uiFixture.component.render(80), []);
  const firstHandle = f.clock.created[0].handle;
  await f.emit("session_start", { reason: "resume" });
  assert.equal(f.clock.active.size, 1, "reattaching on session_start must not accumulate timers");
  assert.equal(f.clock.active.has(firstHandle), false);
  await f.emit("session_shutdown", { reason: "reload" });
  assert.equal(f.clock.active.size, 0);
  assert.equal(f.uiFixture.calls.at(-1).factory, undefined);
  await f.emit("session_start", { reason: "resume" });
  assert.ok(f.uiFixture.component);
  assert.equal(f.clock.active.size, 1);
});

test("extension widget is read-only: rendering never acknowledges, cancels or changes job snapshots", { timeout: 10000 }, async (t) => {
  const f = await extensionFixture(t);
  assert.ok(f.uiFixture.component, "session_start must attach a widget");
  const result = await f.tools.get("bash").execute("widget-call", {
    command: "printf widget-output; sleep 1", background: true,
  }, undefined, undefined, f.ctx);
  const id = result.structuredContent.job_id;
  const before = await f.jobs("status", id);
  const beforeSummary = JSON.parse(before.content[0].text);
  assert.equal(beforeSummary.state, "running");
  for (let i = 0; i < 3; i++) {
    f.clock.tick();
    const rows = plain(f.uiFixture.component.render(100));
    assert.match(rows.join("\n"), /widget-output/);
    f.uiFixture.component.invalidate();
  }
  const after = await f.jobs("status", id);
  assert.deepEqual(after, before, "synchronous widget reads must not mutate the pool or snapshots");
  assert.equal(f.messages.length, 0, "rendering cannot act as acknowledgement or notify the model");
  await f.jobs("cancel", id);
  await waitUntil(async () => JSON.parse((await f.jobs("status", id)).content[0].text).state === "cancelled");
  assert.deepEqual(f.uiFixture.component.render(100), []);
  assert.equal(f.messages.length, 0, "a completed unacknowledged job must remain unacknowledged after rendering");
});

test("shutdown still cancels jobs when removing the widget throws", { timeout: 10000 }, async (t) => {
  const f = await extensionFixture(t);
  const result = await f.tools.get("bash").execute("cleanup-call", { command: "sleep 1", background: true }, undefined, undefined, f.ctx);
  const jobId = result.structuredContent.job_id;
  const originalSetWidget = f.ctx.ui.setWidget;
  t.mock.method(f.ctx.ui, "setWidget", (key, factory, options) => {
    if (factory === undefined) throw new Error("fixture UI cleanup error");
    return originalSetWidget(key, factory, options);
  });
  await assert.rejects(f.emit("session_shutdown", { reason: "quit" }), /fixture UI cleanup error/);
  assert.equal(f.clock.active.size, 0);
  await assert.rejects(f.jobs("status", jobId), /Unknown job/);
  assert.equal(f.messages.length, 0);
});

test("extension wiring never installs the task widget in RPC/JSON/print modes", async (t) => {
  for (const mode of ["rpc", "json", "print"]) {
    await t.test(mode, async (t) => {
      const f = await extensionFixture(t, mode);
      assert.equal(f.clock.created.length, 0);
      assert.equal(f.uiFixture.calls.length, 0);
      await f.emit("session_shutdown", { reason: "quit" });
      assert.equal(f.uiFixture.calls.length, 0);
    });
  }
});
