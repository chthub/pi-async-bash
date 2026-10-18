import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JobPool, type Job } from "./jobs.ts";
import { attachJobWidget } from "./widget.ts";

const DEFAULT_AFTER_SECONDS = 60;
const MAX_AFTER_SECONDS = 2_147_483_647 / 1000;

function completionId(message: { role?: string; customType?: string; details?: unknown }): string | undefined {
  if (message.role !== "custom" || message.customType !== "async_bash_result") return undefined;
  const details = message.details;
  return details && typeof details === "object" && "job_id" in details && typeof details.job_id === "string"
    ? details.job_id : undefined;
}

function summary(job: Job) {
  return {
    job_id: job.id,
    state: job.state,
    command: job.command.slice(0, 160),
    started_at: new Date(job.startedAt).toISOString(),
    ...(job.endedAt ? { ended_at: new Date(job.endedAt).toISOString() } : {}),
    ...(job.exitCode !== undefined ? { exit_code: job.exitCode } : {}),
    ...(job.snapshot.details?.fullOutputPath ? { full_output_path: job.snapshot.details.fullOutputPath } : {}),
  };
}

export default function asyncBash(pi: ExtensionAPI) {
  const native = createBashToolDefinition(process.cwd());
  if (!native.outputSchema) throw new Error("pi-async-bash requires Pi with native structured bash output (tested on 1.3.0)");
  const pool = new JobPool((job) => {
    pi.sendMessage({
      customType: "async_bash_result",
      content: [
        { type: "text", text: `Background bash result: ${JSON.stringify(summary(job))}` },
        ...job.snapshot.content,
      ],
      display: true,
      details: summary(job),
    }, { deliverAs: "steer", triggerTurn: true });
  });

  let detachWidget = () => {};

  pi.registerFlag("bash-background-after", {
    description: "Automatically background bash after this many seconds (default 60; 0 disables automatic backgrounding)",
    type: "string",
    default: String(DEFAULT_AFTER_SECONDS),
  });
  const afterSeconds = () => {
    const raw = pi.getFlag("bash-background-after");
    const value = Number(raw ?? DEFAULT_AFTER_SECONDS);
    if (raw === "" || !Number.isFinite(value) || value < 0 || value > MAX_AFTER_SECONDS) {
      throw new Error(`--bash-background-after must be a number between 0 and ${MAX_AFTER_SECONDS}`);
    }
    return value;
  };

  const parameters = Type.Object({
    ...native.parameters.properties,
    background: Type.Optional(Type.Boolean({ description: "Return a job ID immediately; the command continues in this Pi session" })),
  });
  const runningSchema = Type.Object({
    status: Type.Literal("running"),
    job_id: Type.String(),
  });

  pi.registerTool({
    ...native,
    parameters,
    outputSchema: Type.Union([native.outputSchema, runningSchema]),
    description: `${native.description} Set background:true to return a job ID immediately. Otherwise commands still running after --bash-background-after seconds (default 60; 0 disables) move to the background. Completion arrives as an async_bash_result message. bash_jobs can inspect or cancel jobs in this runtime.`,
    promptSnippet: `${native.promptSnippet}. Long commands can continue in the background and notify you when finished.`,
    promptGuidelines: [
      ...(native.promptGuidelines ?? []),
      "Use background:true for commands you do not need to wait for. A running acknowledgement is not the command's final result; do not rerun it just to wait.",
      "Treat async_bash_result messages as the final result of the original bash command. Use bash_jobs only when progress or cancellation is needed before completion.",
      "Background jobs belong to this live Pi session; they do not survive shutdown, reload, session replacement, or branch navigation.",
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const settings = pi.getSettings();
      // Recreate the official tool with current settings and context for every call.
      // No local process runner, output accumulator, truncation, or timeout handling.
      const bash = createBashToolDefinition(ctx.cwd, {
        shellPath: settings.shellPath,
        commandPrefix: settings.shellCommandPrefix,
      });
      const outcome = await pool.run({
        toolCallId,
        command: params.command,
        background: params.background === true,
        afterSeconds: afterSeconds(),
        signal,
        onUpdate,
        execute: (ownedSignal, update) => bash.execute(toolCallId, params, ownedSignal, update, ctx),
      });
      if ("result" in outcome) return outcome.result;
      const job = outcome.job;
      return {
        content: [{ type: "text", text: `Bash job ${job.id} is running in the background. Its result will arrive automatically; continue independent work. Use bash_jobs if progress or cancellation is needed.` }],
        details: undefined,
        structuredContent: { status: "running", job_id: job.id },
      };
    },
  });

  pi.registerTool({
    name: "bash_jobs",
    label: "Bash jobs",
    promptSnippet: "List, inspect, or cancel background bash jobs in the current Pi session",
    description: "List, inspect, or cancel background bash jobs owned by this live Pi runtime. Status returns the latest native output snapshot and, when truncated, the native full-output file path. No cross-session or stale-process control.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("cancel")], {
        type: "string",
        description: 'One of: "list" (list background jobs), "status" (inspect one job), "cancel" (request cancellation). status and cancel require job_id.',
      }),
      job_id: Type.Optional(Type.String({ description: "Required for status and cancel" })),
    }),
    async execute(_id, params) {
      if (params.action === "list") {
        const jobs = pool.list();
        return {
          content: [{ type: "text", text: JSON.stringify({ total: jobs.length, jobs: jobs.slice(0, 20).map(summary) }) }],
          details: undefined,
        };
      }
      if (!params.job_id) throw new Error(`job_id is required for ${params.action}`);
      const job = params.action === "cancel" ? pool.cancel(params.job_id) : pool.get(params.job_id);
      return {
        content: [{ type: "text", text: JSON.stringify(summary(job)) }, ...job.snapshot.content],
        details: undefined,
      };
    },
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "bash") pool.acknowledge(event.toolCallId);
  });
  pi.on("message_start", (event) => {
    // Unlike message_end, this notification is not a message-transforming hook.
    // Capture consumption before another extension can replace custom metadata.
    const id = completionId(event.message);
    if (id) pool.observeDelivery(id);
  });
  pi.on("turn_end", (event, ctx) => {
    const pending = new Set(event.context.pendingMessages.map(completionId).filter((id): id is string => id !== undefined));
    pool.reconcileNotifications(pending, event.outcome === "completed" && !ctx.signal?.aborted);
  });
  pi.on("agent_settled", (event) => {
    if (event.aborted) pool.retryPendingNotifications();
  });
  pi.on("session_start", (_event, ctx) => {
    afterSeconds();
    pool.start();
    detachWidget();
    detachWidget = attachJobWidget(ctx, () => pool.list());
  });
  pi.on("session_shutdown", async () => {
    try { detachWidget(); }
    finally { await pool.stop(); }
  });
  // Fail closed before navigation/summarization can send work to another branch.
  // Even a navigation attempt vetoed by another extension cancels existing jobs.
  const beforeNavigation = async () => {
    await pool.stop();
    pool.start();
  };
  pi.on("session_before_switch", beforeNavigation);
  pi.on("session_before_fork", beforeNavigation);
  pi.on("session_before_tree", beforeNavigation);
}
