// A keyless, in-process model: no HTTP server, API key, or external provider.
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function scriptedProvider(pi) {
  const plan = JSON.parse(readFileSync(process.env.ASYNC_BASH_TEST_PLAN, "utf8"));
  let request = 0;
  let scriptedUserTurns = 0;
  const model = {
    id: "scripted", name: "Scripted integration model", provider: "async-bash-test",
    api: "async-bash-test", baseUrl: "http://invalid.invalid",
    reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  function stream(_model, context, options = {}) {
    const events = createAssistantMessageEventStream();
    const index = request++;
    // Opt-in repeated user rounds let one live runtime exercise independent Esc
    // recovery cycles; custom-message wakeups must never relaunch the command.
    const userTurns = plan.repeatStepOnUserPrompt ? context.messages.filter((message) =>
      message.role === "user" && (typeof message.content === "string" ? message.content :
        message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")) === plan.repeatStepOnUserPrompt).length : 0;
    const step = plan.repeatStepOnUserPrompt
      ? (userTurns > scriptedUserTurns ? plan.steps[0] : undefined)
      : plan.steps[index];
    scriptedUserTurns = userTurns;
    const output = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: "pending",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(async () => {
      try {
        const messages = context.messages.filter((message) => message.role !== "system");
        // Hash messages, not prompts/tool schemas: sufficient to detect history rewriting
        // without persisting large payloads or credentials in diagnostics.
        appendFileSync(process.env.ASYNC_BASH_TEST_REQUESTS, JSON.stringify({
          index, tools: getCurrentTools(context.messages).map((tool) => tool.name),
          messages: messages.map((message) => ({ role: message.role,
            toolCallId: message.toolCallId,
            hash: createHash("sha256").update(JSON.stringify(message)).digest("hex") })),
        }) + "\n");
        if (index > 30) throw new Error("Unexpected integration model loop");
        if (options.signal?.aborted) throw new Error("Scripted request aborted");
        events.push({ type: "start", partial: output });
        if (step?.tool) {
          if (!getCurrentTools(context.messages).some((tool) => tool.name === step.tool)) {
            throw new Error(`Scripted tool is not declared: ${step.tool}`);
          }
          let args = JSON.stringify(step.args);
          if (args.includes("$JOB")) {
            const result = messages.find((message) => message.role === "toolResult" &&
              JSON.stringify(message.content).match(/bg-[a-f0-9-]+/));
            const id = (JSON.stringify(result?.content) ?? "").match(/bg-[a-f0-9-]+/)?.[0];
            if (!id) throw new Error("No background acknowledgement in model context");
            args = args.replaceAll("$JOB", id);
          }
          const block = { type: "toolCall", id: `scripted-${index}`, name: step.tool, arguments: {} };
          output.content.push(block);
          events.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          block.arguments = JSON.parse(args);
          events.push({ type: "toolcall_delta", contentIndex: 0, delta: args, partial: output });
          events.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: output });
          output.stopReason = "toolUse";
        } else {
          const text = `scripted-idle-${index}`;
          const block = { type: "text", text: "" };
          output.content.push(block);
          events.push({ type: "text_start", contentIndex: 0, partial: output });
          block.text = text;
          events.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
          events.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
          output.stopReason = "stop";
        }
        events.push({ type: "done", reason: output.stopReason, message: output });
      } catch (error) {
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        output.errorMessage = String(error);
        events.push({ type: "error", reason: output.stopReason, error: output });
      } finally {
        events.end();
      }
    });
    return events;
  }
  pi.registerProvider({
    id: model.provider, name: "Keyless integration fixture",
    auth: { apiKey: { name: "No credentials", resolve: async () => ({ auth: {} }) } },
    getModels: () => [model], stream, streamSimple: stream,
  });
  if (plan.completionTransform) {
    if (!["drop-details", "replace-custom-type"].includes(plan.completionTransform)) {
      throw new Error(`Unknown completion transformer: ${plan.completionTransform}`);
    }
    // This fixture loads before async-bash. The public message_end contract lets
    // earlier handlers replace any metadata as long as the role stays unchanged.
    pi.on("message_end", (event) => {
      if (event.message.role !== "custom" || event.message.customType !== "async_bash_result") return;
      return { message: {
        ...event.message,
        ...(plan.completionTransform === "drop-details"
          ? { details: undefined }
          : { customType: "fixture_transformed_result" }),
      } };
    });
  }
  if (plan.dynamicTool) {
    let registered = false;
    pi.on("tool_result", (event) => {
      if (event.toolName !== "bash" || registered) return;
      registered = true;
      pi.registerTool({ name: "late_probe", label: "Late probe", description: "A dynamically registered test tool",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "late-tool-ok" }], details: undefined }),
      });
    });
  }
}
