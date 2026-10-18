import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

/** Read-only view: the UI cannot cancel jobs or inspect/mutate their output. */
export type PendingJobView = Readonly<{
  id: string;
  command: string;
  startedAt: number;
  state: string;
  endedAt?: number;
}>;

const WIDGET_KEY = "async-bash-jobs";
const MAX_ROWS = 3;

function elapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

function commandPreview(command: string): string {
  // Only the display copy is sanitized. Native command/output remain untouched.
  return stripTerminalSequences(command).replace(/\s+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").trim();
}

export function renderJobRows(jobs: readonly PendingJobView[], width: number, theme: Pick<Theme, "fg">, now = Date.now()): string[] {
  const pending = jobs.filter((job) => job.endedAt === undefined && (job.state === "running" || job.state === "cancelling"));
  if (width < 1 || pending.length === 0) return [];
  const fit = (value: string) => truncateToWidth(value, width, "…");
  const lines = [fit(theme.fg("muted", `Background bash · ${pending.length} active`))];
  for (const job of pending.slice(0, MAX_ROWS)) {
    const state = job.state === "cancelling" ? "cancelling" : "running";
    const label = `${job.id.slice(0, 11)} ${state} ${elapsed(job.startedAt, now)}`;
    lines.push(fit(`${theme.fg(job.state === "cancelling" ? "warning" : "accent", label)} ${commandPreview(job.command)}`));
  }
  if (pending.length > MAX_ROWS) lines.push(fit(theme.fg("muted", `+${pending.length - MAX_ROWS} more · bash_jobs to inspect`)));
  return lines;
}

/** Stateless rendering keeps resize and theme changes native; timer is UI-only. */
class JobsComponent implements Component {
  private timer: ReturnType<typeof setInterval>;
  private hadPending = false;
  private readJobs: () => readonly PendingJobView[];
  private tui: Pick<TUI, "requestRender">;
  private theme: Theme;

  constructor(readJobs: () => readonly PendingJobView[], tui: Pick<TUI, "requestRender">, theme: Theme) {
    this.readJobs = readJobs;
    this.tui = tui;
    this.theme = theme;
    this.timer = setInterval(() => {
      const pending = this.readJobs().some((job) => job.endedAt === undefined && (job.state === "running" || job.state === "cancelling"));
      if (pending || this.hadPending) this.tui.requestRender();
      this.hadPending = pending;
    }, 1000);
    this.timer.unref?.();
  }

  render(width: number): string[] {
    const lines = renderJobRows(this.readJobs(), width, this.theme);
    this.hadPending = lines.length > 0;
    return lines;
  }

  invalidate(): void { /* Theme colors and width are evaluated on every render. */ }

  dispose(): void {
    clearInterval(this.timer);
  }
}

/** No widgets or timers in RPC, JSON, or print mode. Does not replace the footer. */
export function attachJobWidget(ctx: Pick<ExtensionContext, "mode" | "ui">, readJobs: () => readonly PendingJobView[]): () => void {
  if (ctx.mode !== "tui") return () => {};
  let component: JobsComponent | undefined;
  let disposed = false;
  ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
    component?.dispose();
    component = new JobsComponent(readJobs, tui, theme);
    return component;
  }, { placement: "belowEditor" });
  return () => {
    if (disposed) return;
    disposed = true;
    component?.dispose();
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  };
}
