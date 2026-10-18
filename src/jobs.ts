import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentToolUpdateCallback, BashToolDetails } from "@earendil-works/pi-coding-agent";

export type NativeResult = AgentToolResult<BashToolDetails | undefined>;
type Outcome = { result: NativeResult } | { error: unknown };
export type Job = {
  id: string;
  toolCallId: string;
  command: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "cancelling" | "completed" | "failed" | "cancelled";
  background: boolean;
  acknowledged: boolean;
  notified: boolean;
  controller: AbortController;
  snapshot: NativeResult;
  exitCode?: number;
};

type RunOptions = {
  toolCallId: string;
  command: string;
  background: boolean;
  afterSeconds: number;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<BashToolDetails | undefined>;
  execute: (signal: AbortSignal, update: AgentToolUpdateCallback<BashToolDetails | undefined>) => Promise<NativeResult>;
};

/** Scheduling only. Pi owns execution, output buffering, truncation, and cancellation. */
export class JobPool {
  private jobs = new Map<string, Job>();
  private inFlight = new Set<Promise<Outcome>>();
  private closed = false;
  private generation = 0;
  private notify: (job: Job) => void;

  constructor(notify: (job: Job) => void) {
    this.notify = notify;
  }

  async run(options: RunOptions): Promise<{ result: NativeResult } | { job: Job }> {
    if (this.closed) throw new Error("Async bash is shutting down");
    const generation = this.generation;
    const job: Job = {
      id: `bg-${randomUUID()}`,
      toolCallId: options.toolCallId,
      command: options.command,
      startedAt: Date.now(),
      state: "running",
      background: options.background,
      acknowledged: false,
      notified: false,
      controller: new AbortController(),
      snapshot: { content: [], details: undefined },
    };
    this.jobs.set(job.id, job);
    const forwardAbort = () => job.controller.abort();
    if (options.signal?.aborted) forwardAbort();
    // A background job is owned by the session, not by the tool call's signal.
    if (!options.background) options.signal?.addEventListener("abort", forwardAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done: Promise<Outcome> = Promise.resolve().then(() => options.execute(job.controller.signal, (update) => {
      job.snapshot = { content: update.content, details: update.details };
      if (!job.background) options.onUpdate?.(update);
    })).then((result): Outcome => {
      const structured = result.structuredContent as { exit_code?: unknown } | undefined;
      if (typeof structured?.exit_code === "number") job.exitCode = structured.exit_code;
      job.state = result.isError ? "failed" : "completed";
      // Do not retain the native 1-MiB structured output in the job registry.
      job.snapshot = { content: result.content, details: result.details, ...(result.isError ? { isError: true } : {}) };
      return { result };
    }, (error: unknown): Outcome => {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.snapshot = {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        details: job.snapshot.details,
        isError: true,
      };
      return { error };
    }).then((outcome) => {
      job.endedAt = Date.now();
      options.signal?.removeEventListener("abort", forwardAbort);
      this.inFlight.delete(done);
      this.deliver(job, generation);
      this.prune();
      return outcome;
    });
    this.inFlight.add(done);

    try {
      if (options.background && !job.controller.signal.aborted) return { job };
      let outcome = options.afterSeconds > 0 && !job.controller.signal.aborted
        ? await Promise.race([
          done,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), options.afterSeconds * 1000);
          }),
        ])
        : await done;
      // Cancellation wins over detachment if it races the threshold.
      if (outcome === undefined && job.controller.signal.aborted) outcome = await done;
      if (outcome === undefined) {
        job.background = true;
        options.signal?.removeEventListener("abort", forwardAbort);
        return { job };
      }
      this.jobs.delete(job.id);
      if ("error" in outcome) throw outcome.error;
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Called by the tool_result observer, never by context/history mutation. */
  acknowledge(toolCallId: string): void {
    for (const job of this.jobs.values()) {
      if (job.toolCallId !== toolCallId || !job.background) continue;
      job.acknowledged = true;
      this.deliver(job, this.generation);
    }
    this.prune();
  }

  private deliver(job: Job, generation: number): void {
    if (!job.background || !job.acknowledged || !job.endedAt || job.notified) return;
    job.notified = true;
    // Let the acknowledgement handler return before scheduling the steer.
    setImmediate(() => {
      if (!this.closed && generation === this.generation) this.notify(job);
    });
  }

  get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job?.background) throw new Error(`Unknown job in this runtime: ${id}`);
    return job;
  }

  list(): Job[] {
    return [...this.jobs.values()].filter((job) => job.background).reverse();
  }

  cancel(id: string): Job {
    const job = this.get(id);
    if (!job.endedAt) {
      job.state = "cancelling";
      job.controller.abort();
    }
    return job;
  }

  private prune(): void {
    const completed = this.list().filter((job) => job.endedAt && job.notified);
    for (const job of completed.slice(20)) this.jobs.delete(job.id);
  }

  /** Session/branch changes must never deliver an old job into a new conversation. */
  async stop(): Promise<void> {
    this.closed = true;
    this.generation++;
    for (const job of this.jobs.values()) if (!job.endedAt) job.controller.abort();
    await Promise.all([...this.inFlight]);
    this.jobs.clear();
  }

  start(): void {
    this.closed = false;
  }
}
