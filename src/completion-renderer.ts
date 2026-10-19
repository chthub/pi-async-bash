import type { BashToolDetails, MessageRenderer, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, MouseRegion, Text } from "@earendil-works/pi-tui";

export interface CompletionDetails {
  job_id: string;
  state: string;
  command: string;
  exit_code?: number;
  nativeDetails?: BashToolDetails;
}

/** Reuse Pi's bash preview; only the custom-message framing and click state are local. */
export function createCompletionRenderer(native: ReturnType<typeof createBashToolDefinition>): MessageRenderer<CompletionDetails> {
  const renderResult = native.renderResult;
  const views = new WeakMap<object, { globalExpanded: boolean; expanded: boolean }>();
  return (message, options, theme) => {
    if (!renderResult) return undefined;
    let view = views.get(message);
    if (!view || view.globalExpanded !== options.expanded) {
      view = { globalExpanded: options.expanded, expanded: options.expanded };
      views.set(message, view);
    }
    const state = view;
    const details = message.details;
    const content = typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content;
    // Keep the model-facing summary intact, but show it as a fixed header in the TUI.
    const hasSummary = content[0]?.type === "text" && content[0].text.startsWith("Background bash result: ");
    const result = { content: hasSummary && details ? content.slice(1) : content, details: details?.nativeDetails };
    const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
    const rebuild = () => {
      box.clear();
      let label = "[async_bash_result]";
      if (details) {
        label += ` ${details.job_id} ${details.state}`;
        if (details.exit_code !== undefined) label += ` (exit ${details.exit_code})`;
      }
      box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(label)), 0, 0));
      if (details?.command) box.addChild(new Text(theme.fg("toolTitle", `$ ${details.command}`), 0, 0));
      box.addChild(renderResult(result, { expanded: state.expanded, isPartial: false }, theme, {
        args: { command: details?.command ?? "" },
        toolCallId: details?.job_id ?? "async_bash_result",
        invalidate: rebuild,
        lastComponent: undefined,
        state: { startedAt: undefined, endedAt: undefined, interval: undefined },
        cwd: process.cwd(),
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: state.expanded,
        showImages: false,
        isError: details?.state === "failed" || details?.state === "cancelled",
        durationMs: undefined,
        outputPad: options.outputPad,
      }));
    };
    rebuild();
    return new MouseRegion(box, (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      state.expanded = !state.expanded;
      rebuild();
      return { handled: true };
    });
  };
}
