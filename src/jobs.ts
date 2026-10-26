import { randomBytes } from "node:crypto";
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
  delivery: "pending" | "scheduled" | "queued" | "consumed" | "delivered";
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
    let id: string;
    do {
      id = `bg-${randomBytes(4).toString("hex")}`;
    } while (this.jobs.has(id));
    const job: Job = {
      id,
      toolCallId: options.toolCallId,
      command: options.command,
      startedAt: Date.now(),
      state: "running",
      background: options.background,
      acknowledged: false,
      delivery: "pending",
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
    if (!job.background || !job.acknowledged || !job.endedAt || job.delivery !== "pending") return;
    job.delivery = "scheduled";
    // Let the acknowledgement handler return before scheduling the steer.
    setImmediate(() => {
      if (!this.closed && generation === this.generation) this.enqueue(job);
    });
  }

  private enqueue(job: Job): void {
    job.delivery = "queued";
    try {
      this.notify(job);
    } catch {
      // A failed enqueue is not delivery. Keep the result for a later boundary.
      job.delivery = "pending";
    }
  }

  /** Pi has started consuming the message. message_end may replace its metadata,
   * so remember the original ID now and never resend a consumed notification.
   */
  observeDelivery(id: string): void {
    const job = this.jobs.get(id);
    if (!job?.background || !job.endedAt || job.delivery === "delivered") return;
    job.delivery = "consumed";
  }

  /** Observe the public turn boundary, after earlier steering has been consumed.
   * Clear-queue/Escape can discard a queued custom message. Record missing items
   * while aborting; the settled handler retries them after that run has stopped.
   * Pi's snapshot shows only the queue head in one-at-a-time mode, so absence is
   * evidence of loss only when the snapshot is empty.
   */
  reconcileNotifications(pendingIds: ReadonlySet<string>, retry: boolean, queueEmpty = pendingIds.size === 0): void {
    if (this.closed) return;
    for (const job of this.jobs.values()) {
      // Pi awaits custom start/end before the request and this turn boundary.
      // This also confirms consumed messages on aborted/error turns, without
      // depending on message_end metadata or pairing possibly interleaved events.
      if (job.delivery === "consumed") job.delivery = "delivered";
      if (!job.background || !job.acknowledged || !job.endedAt || job.delivery === "delivered") continue;
      if (job.delivery === "queued" && queueEmpty) job.delivery = "pending";
      if (retry && job.delivery === "pending" && !pendingIds.has(job.id)) this.enqueue(job);
    }
    this.prune();
  }

  /** Retry only missing notifications, once the aborted run has fully stopped.
   * deliver() marks them scheduled before deferring, so repeated settlement
   * signals cannot enqueue duplicates. Queued/consumed/delivered items are skipped.
   */
  retryPendingNotifications(): void {
    if (this.closed) return;
    for (const job of this.jobs.values()) this.deliver(job, this.generation);
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
    const completed = this.list().filter((job) => job.endedAt && job.delivery === "delivered");
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
