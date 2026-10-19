import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createBashToolDefinition, CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createCompletionRenderer } from "../src/completion-renderer.ts";

initTheme("dark", false);
const native = createBashToolDefinition(process.cwd());
const render = createCompletionRenderer(native);
const output = Array.from({ length: 30 }, (_, i) => `output-${String(i).padStart(2, "0")}`).join("\n");

function message(text = output, extraDetails = {}) {
  const summary = { job_id: "bg-12345678", state: "completed", command: "printf output", exit_code: 0 };
  return {
    role: "custom", customType: "async_bash_result", display: true, timestamp: 0,
    details: { ...summary, ...extraDetails },
    content: [
      { type: "text", text: `Background bash result: ${JSON.stringify(summary)}` },
      { type: "text", text },
    ],
  };
}

const lines = (component, width = 80) => component.render(width).map(stripVTControlCharacters);
const text = (component, width = 80) => lines(component, width).join("\n");
function click(component, width = 80, fields = {}) {
  const height = component.render(width).length;
  return component.handleMouse({
    type: "click", button: "left", x: 2, y: 2, screenX: 2, screenY: 2,
    width, height, shift: false, alt: false, ctrl: false, ...fields,
  });
}

function component(msg = message(), outputPad = 1) {
  return new CustomMessageComponent(msg, render, undefined, outputPad);
}

test("native bash preview keeps the last five lines and a fixed job header", () => {
  const msg = message();
  const before = structuredClone(msg);
  const view = component(msg);
  const collapsed = text(view);
  assert.match(collapsed, /\[async_bash_result\] bg-12345678 completed \(exit 0\)/);
  assert.match(collapsed, /\$ printf output/);
  assert.match(collapsed, /25 earlier lines/);
  assert.match(collapsed, /to expand/);
  assert.doesNotMatch(collapsed, /output-00|output-24|Background bash result:/);
  for (let i = 25; i < 30; i++) assert.ok(collapsed.includes(`output-${i}`));
  assert.deepEqual(msg, before, "display must not mutate model-facing content or details");
});

test("Pi's Ctrl+O expansion path expands and collapses custom messages", () => {
  const view = component();
  view.setExpanded(true);
  assert.match(text(view), /output-00/);
  assert.doesNotMatch(text(view), /earlier lines/);
  view.setExpanded(false);
  assert.doesNotMatch(text(view), /output-00/);
  assert.match(text(view), /25 earlier lines/);
});

test("fullscreen left clicks toggle output and preserve local state across invalidation", () => {
  const view = component();
  assert.equal(click(view).handled, true);
  assert.match(text(view), /output-00/);
  view.invalidate();
  assert.match(text(view), /output-00/, "theme/redraw invalidation must not undo a click");
  assert.equal(click(view).handled, true);
  assert.doesNotMatch(text(view), /output-00/);
  view.setExpanded(true);
  assert.match(text(view), /output-00/);
  view.setExpanded(false);
  assert.doesNotMatch(text(view), /output-00/);
});

test("right clicks and mouse drags do not toggle output", () => {
  const view = component();
  assert.equal(click(view, 80, { button: "right" }), undefined);
  assert.equal(click(view, 80, { type: "drag" }), undefined);
  assert.doesNotMatch(text(view), /output-00/);
});

test("native visual-line folding bounds a single long line and handles terminal resize", () => {
  const view = component(message("中文🙂".repeat(1000)));
  for (const width of [20, 40, 100, 20]) {
    const rendered = lines(view, width);
    assert.ok(rendered.length < 20, `preview must stay compact at width ${width}`);
    assert.ok(rendered.every((line) => visibleWidth(line) <= width));
    // Pi truncates the hint itself in narrow terminals.
    assert.match(rendered.join("\n"), /\.\.\. \(/);
    if (width === 100) assert.match(rendered.join("\n"), /to expand/);
  }
  view.setExpanded(true);
  assert.ok(lines(view, 20).length > 100);
});

test("native truncation warnings retain the full-output path when collapsed", () => {
  const fullOutputPath = "/tmp/pi-bash-render-test.log";
  const view = component(message(`${output}\n\n[Showing lines 1-30 of 2500. Full output: ${fullOutputPath}]`, {
    state: "failed", exit_code: 23,
    nativeDetails: {
      fullOutputPath,
      truncation: { truncated: true, truncatedBy: "lines", outputLines: 30, totalLines: 2500 },
    },
  }));
  const collapsed = text(view, 120);
  assert.match(collapsed, /failed \(exit 23\)/);
  assert.ok(collapsed.includes(`Full output: ${fullOutputPath}`));
  assert.match(collapsed, /Truncated: showing 30 of 2500 lines/);
  view.setExpanded(true);
  assert.match(text(view, 120), /output-00/);
  assert.equal(text(view, 120).split(fullOutputPath).length - 1, 1, "native footer is not duplicated");
});

test("short output is shown in full without an expansion hint", () => {
  const view = component(message("hello\nworld"));
  assert.match(text(view), /hello\s*\n/);
  assert.match(text(view), /world/);
  assert.doesNotMatch(text(view), /earlier lines|to expand/);
});

test("resumed messages without new rendering metadata remain readable", () => {
  const old = message();
  delete old.details;
  old.content = `Legacy summary\n${output}`;
  const view = component(old, 0);
  assert.match(text(view), /earlier lines/);
  view.setExpanded(true);
  assert.match(text(view), /Legacy summary/);
  assert.match(text(view), /output-00/);
});
