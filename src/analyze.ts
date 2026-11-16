// Pure parsing and aggregation for the `/usage` command. No fs or pi imports.
//
// Session files are JSONL under `~/.pi/agent/sessions/--<cwd>--/`, where `<cwd>`
// is the working directory with `/` replaced by `-`. Each line is an entry with
// a `type` field; assistant messages carry a `usage` object with token and cost
// totals (see docs/session-format.md in the pi distribution).

/** Optional local price table in USD per 1M tokens, keyed by `provider/model`.
 * Empty by default: free models report zero cost and paid usage shows the
 * provider-reported cost from session files. Extend locally as needed. */
export const PRICE_TABLE: Readonly<Record<string, number>> = {};

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface ModelUsage extends UsageTotals {
  calls: number;
}

export interface ToolUsage {
  calls: number;
  errors: number;
  totalTokens: number;
  cost: number;
}

export interface SessionRow {
  file: string;
  startedAt?: string;
  lastAt?: string;
  totalTokens: number;
  model?: string;
  cost: number;
}

export interface FileSummary {
  file: string;
  startedAt?: string;
  lastAt?: string;
  totals: UsageTotals;
  byModel: Map<string, ModelUsage>;
  byTool: Map<string, ToolUsage>;
  bySubagent: Map<string, ToolUsage>;
  byDay: Map<string, UsageTotals>;
  byDayByModel: Map<string, Map<string, UsageTotals>>;
}

export interface UsageReport {
  cwd: string;
  skipped: number;
  sessions: SessionRow[];
  totals: UsageTotals;
  byModel: Map<string, ModelUsage>;
  byTool: Map<string, ToolUsage>;
  bySubagent: Map<string, ToolUsage>;
  byDay: Map<string, UsageTotals>;
}

const EMPTY = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } satisfies UsageTotals;

const TOOL_EMPTY = { calls: 0, errors: 0, totalTokens: 0, cost: 0 } satisfies ToolUsage;

/** Encode a working directory into its session storage dir name:
 * `/a/b` -> `--a-b--` (leading/trailing slashes dropped before replacing). */
export function encodeProjectDir(cwd: string): string {
  const cleaned = cwd.replace(/^\/+|\/+$/g, "");
  return `--${cleaned.replaceAll("/", "-")}--`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

const LEVELS = "▁▂▃▄▅▆▇█";

/** Index into LEVELS (0..7) for a value within [min, max]. */
function levelFor(value: number, min: number, max: number): number {
  if (value <= 0) return 0;
  if (max <= min) return LEVELS.length - 1;
  return Math.min(LEVELS.length - 1, Math.floor(((value - min) / (max - min)) * LEVELS.length));
}

/** Sparkline of `values` right-aligned into `width` columns (older days left).
 * Values longer than `width` are bucketed by the caller via `dailySeries`. */
export function sparkline(values: readonly number[], width = 24): string {
  if (values.length === 0 || width < 1) return "";
  const padded = values.length < width ? [...Array(width - values.length).fill(0), ...values] : values;
  const max = Math.max(...padded);
  const min = Math.min(...padded);
  return padded.map((value) => LEVELS[levelFor(value, min, max)]).join("");
}

/** Token totals per day, sorted ascending by date and bucketed to at most
 * `width` buckets (summing consecutive days) so a long history fits the line. */
export function dailySeries(byDay: ReadonlyMap<string, UsageTotals>, width: number): number[] {
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (days.length === 0 || width < 1) return [];
  const values = days.map(([, usage]) => usage.totalTokens);
  if (values.length <= width) return values;
  const bucketSize = Math.ceil(values.length / width);
  const buckets: number[] = [];
  for (let i = 0; i < values.length; i += bucketSize) {
    buckets.push(values.slice(i, i + bucketSize).reduce((sum, value) => sum + value, 0));
  }
  return buckets;
}

export interface BarRow {
  label: string;
  value: number;
  detail?: string;
}

function truncateLabel(label: string, max: number): string {
  return label.length <= max ? label.padEnd(max) : `${label.slice(0, max - 1)}…`;
}

/** Horizontal bar rows scaled to `width` columns; rows with value > 0 get at
 * least one bar so tiny shares remain visible. */
export function renderBars(rows: readonly BarRow[], width: number): string[] {
  if (rows.length === 0 || width < 1) return [];
  const max = Math.max(...rows.map((row) => row.value));
  const labelWidth = 30;
  if (max <= 0) {
    return rows.map((row) => `  ${truncateLabel(row.label, labelWidth)} ${row.detail ?? ""}`.trimEnd());
  }
  return rows.map((row) => {
    const count = row.value > 0 ? Math.max(1, Math.round((row.value / max) * width)) : 0;
    const bar = "█".repeat(Math.min(count, width));
    const detail = row.detail ? ` · ${row.detail}` : "";
    return `  ${truncateLabel(row.label, labelWidth)} ${bar} ${formatTokens(row.value)}${detail}`;
  });
}

function cloneEmpty(): UsageTotals {
  return { ...EMPTY };
}

export function parseUsage(value: unknown): UsageTotals | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const numeric = (key: string): number =>
    typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : 0;
  const costRecord = (record.cost ?? {}) as Record<string, unknown>;
  return {
    input: numeric("input"),
    output: numeric("output"),
    cacheRead: numeric("cacheRead"),
    cacheWrite: numeric("cacheWrite"),
    totalTokens: numeric("totalTokens"),
    cost: typeof costRecord.total === "number" && Number.isFinite(costRecord.total) ? costRecord.total : 0,
  };
}

function addTotals(target: UsageTotals, usage: UsageTotals): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.cost += usage.cost;
}

function mergeModelUsage(target: Map<string, ModelUsage>, key: string, usage: UsageTotals, calls: number): void {
  const entry = target.get(key) ?? { ...EMPTY, calls: 0 };
  addTotals(entry, usage);
  entry.calls += calls;
  target.set(key, entry);
}

function addDayModel(
  target: Map<string, Map<string, UsageTotals>>,
  day: string,
  model: string,
  usage: UsageTotals,
): void {
  let models = target.get(day);
  if (!models) {
    models = new Map();
    target.set(day, models);
  }
  const entry = models.get(model) ?? cloneEmpty();
  addTotals(entry, usage);
  models.set(model, entry);
}

function mergeToolUsage(
  target: Map<string, ToolUsage>,
  key: string,
  calls: number,
  errors: number,
  usage?: { totalTokens?: number; cost?: number },
): void {
  const entry = target.get(key) ?? { ...TOOL_EMPTY };
  entry.calls += calls;
  entry.errors += errors;
  if (usage) {
    entry.totalTokens += usage.totalTokens ?? 0;
    entry.cost += usage.cost ?? 0;
  }
  target.set(key, entry);
}

/** Aggregate one session file. Tolerant of malformed lines and entries:
 * they are skipped instead of failing the whole file. Entries with a
 * timestamp earlier than `since` (epoch ms) are skipped, enabling period
 * windows ("1d" / "7d" / "30d"). */
export function analyzeFile(file: string, lines: readonly string[], since?: number): FileSummary {
  const summary: FileSummary = {
    file,
    totals: cloneEmpty(),
    byModel: new Map(),
    byTool: new Map(),
    bySubagent: new Map(),
    byDay: new Map(),
    byDayByModel: new Map(),
  };
  const subagentCalls = new Map<string, string>(); // toolCallId -> agent name
  let lastModel: string | undefined;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (since !== undefined && ts) {
      const epoch = Date.parse(ts);
      if (Number.isFinite(epoch) && epoch < since) continue;
    }
    const day = ts?.slice(0, 10);
    if (ts) {
      if (!summary.startedAt || ts < summary.startedAt) summary.startedAt = ts;
      if (!summary.lastAt || ts > summary.lastAt) summary.lastAt = ts;
    }

    switch (entry.type) {
      case "model_change": {
        if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
          lastModel = `${entry.provider}/${entry.modelId}`;
        }
        break;
      }
      case "message": {
        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg || typeof msg !== "object") break;
        if (msg.role === "assistant") {
          if (typeof msg.provider === "string" && typeof msg.model === "string") {
            lastModel = `${msg.provider}/${msg.model}`;
          }
          const usage = parseUsage(msg.usage);
          if (usage) {
            addTotals(summary.totals, usage);
            const modelKey = lastModel ?? "unknown";
            mergeModelUsage(summary.byModel, modelKey, usage, 1);
            if (day) {
              const dayUsage = summary.byDay.get(day) ?? cloneEmpty();
              addTotals(dayUsage, usage);
              summary.byDay.set(day, dayUsage);
              addDayModel(summary.byDayByModel, day, modelKey, usage);
            }
          }
          const content = Array.isArray(msg.content) ? msg.content : [];
          for (const block of content) {
            const item = block as Record<string, unknown>;
            if (item?.type !== "toolCall" || item.name !== "subagent" || typeof item.id !== "string") continue;
            const args = (item.arguments ?? {}) as Record<string, unknown>;
            subagentCalls.set(item.id, typeof args.agent === "string" ? args.agent : "unknown");
          }
        } else if (msg.role === "toolResult") {
          const toolName = typeof msg.toolName === "string" ? msg.toolName : "unknown";
          const toolUsage = parseUsage(msg.usage);
          mergeToolUsage(summary.byTool, toolName, 1, msg.isError === true ? 1 : 0, toolUsage);
          if (toolName === "subagent" && typeof msg.toolCallId === "string") {
            const agent = subagentCalls.get(msg.toolCallId) ?? "unknown";
            mergeToolUsage(summary.bySubagent, agent, 1, msg.isError === true ? 1 : 0, toolUsage);
          }
          if (toolUsage && day) {
            const dayUsage = summary.byDay.get(day) ?? cloneEmpty();
            addTotals(dayUsage, toolUsage);
            summary.byDay.set(day, dayUsage);
          }
        }
        break;
      }
      case "compaction": {
        const usage = parseUsage(entry.usage);
        if (usage) {
          addTotals(summary.totals, usage);
          mergeModelUsage(summary.byModel, lastModel ?? "summary", usage, 0);
          if (day) {
            const dayUsage = summary.byDay.get(day) ?? cloneEmpty();
            addTotals(dayUsage, usage);
            summary.byDay.set(day, dayUsage);
          }
        }
        break;
      }
    }
  }
  return summary;
}

export interface MergedUsage {
  skipped: number;
  sessions: SessionRow[];
  totals: UsageTotals;
  byModel: Map<string, ModelUsage>;
  byTool: Map<string, ToolUsage>;
  bySubagent: Map<string, ToolUsage>;
  byDay: Map<string, UsageTotals>;
  byDayByModel: Map<string, Map<string, UsageTotals>>;
}

function primaryModelKey(byModel: ReadonlyMap<string, ModelUsage>): string | undefined {
  let best: string | undefined;
  let tokens = -1;
  for (const [key, usage] of byModel) {
    if (usage.totalTokens > tokens) {
      best = key;
      tokens = usage.totalTokens;
    }
  }
  return best;
}

export function mergeReports(files: readonly FileSummary[], skipped = 0): MergedUsage {
  const merged: MergedUsage = {
    skipped,
    sessions: [],
    totals: cloneEmpty(),
    byModel: new Map(),
    byTool: new Map(),
    bySubagent: new Map(),
    byDay: new Map(),
    byDayByModel: new Map(),
  };
  for (const file of files) {
    addTotals(merged.totals, file.totals);
    merged.sessions.push({
      file: file.file,
      startedAt: file.startedAt,
      lastAt: file.lastAt,
      totalTokens: file.totals.totalTokens,
      model: primaryModelKey(file.byModel),
      cost: file.totals.cost,
    });
    for (const [key, usage] of file.byModel) mergeModelUsage(merged.byModel, key, usage, usage.calls);
    for (const [key, usage] of file.byTool) mergeToolUsage(merged.byTool, key, usage.calls, usage.errors, usage);
    for (const [key, usage] of file.bySubagent) mergeToolUsage(merged.bySubagent, key, usage.calls, usage.errors, usage);
    for (const [key, usage] of file.byDay) {
      const dayUsage = merged.byDay.get(key) ?? cloneEmpty();
      addTotals(dayUsage, usage);
      merged.byDay.set(key, dayUsage);
    }
    for (const [day, models] of file.byDayByModel) {
      for (const [model, usage] of models) addDayModel(merged.byDayByModel, day, model, usage);
    }
  }
  merged.sessions.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return merged;
}

function toolRow(entries: [string, ToolUsage][]): string {
  return entries
    .map(([name, usage]) => {
      const status = usage.errors > 0 ? `${usage.calls} (${usage.errors} err)` : String(usage.calls);
      return usage.totalTokens > 0 ? `${name} ${status} · ${formatTokens(usage.totalTokens)}` : `${name} ${status}`;
    })
    .join(" · ");
}

/** Cost of a model entry in USD: provider-reported unless `PRICE_TABLE`
 * overrides it for that `provider/model` key. */
export function modelCost(key: string, usage: { totalTokens: number; cost: number }): number {
  const price = PRICE_TABLE[key];
  return price !== undefined ? (usage.totalTokens / 1_000_000) * price : usage.cost;
}

export interface RenderOptions {
  /** Width of model bars and daily sparkline in columns. */
  barWidth?: number;
}

export function renderReport(report: UsageReport, options: RenderOptions = {}): string {
  const { cwd, totals, byModel, byTool, bySubagent, byDay, sessions, skipped } = report;
  const barWidth = options.barWidth ?? 24;
  const lines: string[] = [];
  lines.push(`Usage — ${cwd}`);
  lines.push(
    `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${formatTokens(totals.totalTokens)} tokens total · $${totals.cost.toFixed(2)}` +
      (skipped > 0 ? ` · ${skipped} skipped (large/unreadable)` : ""),
  );

  const series = dailySeries(byDay, barWidth);
  if (series.length > 0) {
    const latestDay = [...byDay.keys()].sort().at(-1);
    const latest = latestDay ? byDay.get(latestDay)?.totalTokens ?? 0 : 0;
    lines.push(`Daily (${series.length} day${series.length === 1 ? "" : "s"}): ${sparkline(series, barWidth)} · latest ${formatTokens(latest)}`);
  }

  const modelRows = [...byModel.entries()]
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    .slice(0, 10)
    .map(([key, usage]) => {
      const cost = modelCost(key, usage);
      return { label: key, value: usage.totalTokens, detail: `${usage.calls} calls · $${cost.toFixed(2)}` };
    });
  if (modelRows.length > 0) {
    lines.push("", "By model:");
    lines.push(...renderBars(modelRows, barWidth));
    if (byModel.size > modelRows.length) lines.push(`  (+${byModel.size - modelRows.length} more models)`);
  }

  const tools = [...byTool.entries()].sort((a, b) => b[1].calls - a[1].calls);
  if (tools.length > 0) {
    lines.push("", `By tool: ${toolRow(tools.slice(0, 8))}`);
    if (tools.length > 8) lines.push(`  (+${tools.length - 8} more tools)`);
  }

  const subagents = [...bySubagent.entries()].sort((a, b) => b[1].calls - a[1].calls);
  if (subagents.length > 0) {
    lines.push("", `Subagents: ${toolRow(subagents.slice(0, 6))}`);
  }

  if (sessions.length > 0) {
    lines.push("", "Sessions:");
    for (const session of sessions.slice(0, 5)) {
      const date = session.startedAt ? session.startedAt.slice(0, 10) : "unknown";
      const file = session.file.split(/[\\/]/).pop() ?? session.file;
      lines.push(`  ${date} ${file} — ${formatTokens(session.totalTokens)} tokens`);
    }
    if (sessions.length > 5) lines.push(`  (+${sessions.length - 5} older sessions)`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Interactive view model (TUI) — pure data consumed by `view.ts`.
// Mirrors Claude Code's `/usage` screen (plan-limit bars) against local data:
// caps come from `DEFAULT_LIMITS` unless the user opts into an explicit
// `usageLimits` block in settings.json (read-only; never written here).
// ---------------------------------------------------------------------------

export type Period = "1d" | "7d" | "30d" | "all";

const PERIOD_DAYS: Record<Exclude<Period, "all">, number> = { "1d": 1, "7d": 7, "30d": 30 };
const DAY_MS = 86_400_000;

/** Epoch-ms cutoff for a period, or undefined for "all". Days are measured in
 * UTC to match session timestamps (UTC ISO with Z). */
export function periodSince(period: Period, nowMs: number): number | undefined {
  if (period === "all") return undefined;
  return nowMs - PERIOD_DAYS[period] * DAY_MS;
}

/** UTC day key (YYYY-MM-DD), matching entry `timestamp.slice(0, 10)`. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const WEEKDAYS = "SMTWTFS";

export function weekdayLetter(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return " ";
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? " ";
}

/** Columns on the Usage daily chart. 1d/7d share a week so a single day is not a stub. */
export function chartDayCount(period: Period): number {
  if (period === "30d") return 30;
  if (period === "all") return 14;
  return 7;
}

export function dailyChartPoints(
  byDay: ReadonlyMap<string, UsageTotals>,
  count: number,
  nowMs: number,
): ChartPoint[] {
  const days = Math.max(1, Math.floor(count));
  const points: ChartPoint[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = dayKey(nowMs - offset * DAY_MS);
    points.push({ date, tokens: byDay.get(date)?.totalTokens ?? 0 });
  }
  return points;
}

/** Column chart, top row first. Glyphs match the CC progress block set. */
export function renderDailyChartLines(
  points: readonly ChartPoint[],
  height = 5,
): { lines: string[]; labels: string; caption: string } {
  const rows = Math.max(1, Math.floor(height));
  const max = Math.max(0, ...points.map((point) => point.tokens));
  const gap = points.length <= 14 ? " " : "";
  const columns = points.map((point) => {
    const filled = max > 0 ? (point.tokens / max) * rows : 0;
    const glyphs: string[] = [];
    for (let row = rows - 1; row >= 0; row--) {
      if (filled >= row + 1) glyphs.push("█");
      else if (filled >= row + 0.45) glyphs.push("▄");
      else glyphs.push(" ");
    }
    return glyphs;
  });
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    lines.push(columns.map((column) => column[row]).join(gap));
  }
  const latest = points.at(-1)?.tokens ?? 0;
  return {
    lines,
    labels: points.map((point) => weekdayLetter(point.date)).join(gap),
    caption: `latest ${formatTokens(latest)}`,
  };
}

export const HEATMAP_GLYPHS = ".░▒▓█";

export interface HeatmapWeek {
  readonly start: string;
  readonly levels: readonly number[];
}

export function cacheHitPercent(totals: UsageTotals): number | undefined {
  const denom = totals.input + totals.cacheRead;
  if (denom <= 0) return undefined;
  return Math.floor((totals.cacheRead / denom) * 100);
}

export function outputRatio(totals: UsageTotals): number | undefined {
  if (totals.input <= 0 || totals.output <= 0) return undefined;
  return totals.output / totals.input;
}

/** CodeBurn-style one-liner: cache hit and output leverage. */
export function usageKpiText(totals: UsageTotals): string | undefined {
  const parts: string[] = [];
  const cache = cacheHitPercent(totals);
  if (cache !== undefined) parts.push(`cache ${cache}%`);
  const ratio = outputRatio(totals);
  if (ratio !== undefined) parts.push(`${ratio.toFixed(1)}x out/in`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function heatmapWeekCount(period: Period): number {
  if (period === "all") return 52;
  if (period === "30d") return 8;
  return 8;
}

function startOfUtcMonday(ms: number): number {
  const date = new Date(ms);
  const weekday = date.getUTCDay();
  const offset = weekday === 0 ? 6 : weekday - 1;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset);
}

export function heatmapLevel(tokens: number, max: number): number {
  if (tokens <= 0 || max <= 0) return 0;
  const ratio = tokens / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

/** GitHub-style week grid. Rows are Mon–Sun; columns are weeks ending this week. */
export function activityHeatmap(
  byDay: ReadonlyMap<string, UsageTotals>,
  weeks: number,
  nowMs: number,
): HeatmapWeek[] {
  const count = Math.max(1, Math.floor(weeks));
  const thisMonday = startOfUtcMonday(nowMs);
  const startSunday = thisMonday - (count - 1) * 7 * DAY_MS;
  let max = 0;
  const raw: { start: string; tokens: number[] }[] = [];
  for (let week = 0; week < count; week++) {
    const startMs = startSunday + week * 7 * DAY_MS;
    const tokens: number[] = [];
    for (let day = 0; day < 7; day++) {
      const value = byDay.get(dayKey(startMs + day * DAY_MS))?.totalTokens ?? 0;
      tokens.push(value);
      if (value > max) max = value;
    }
    raw.push({ start: dayKey(startMs), tokens });
  }
  return raw.map((week) => ({
    start: week.start,
    levels: week.tokens.map((tokens) => heatmapLevel(tokens, max)),
  }));
}

const HEATMAP_ROW_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""] as const;

export function renderHeatmapLines(weeks: readonly HeatmapWeek[]): { header: string; rows: string[]; legend: string } {
  const header = ["    ", ...weeks.map((week) => {
    const day = Number(week.start.slice(8, 10));
    const month = Number(week.start.slice(5, 7));
    if (day > 7 || month < 1 || month > 12) return " ";
    return "JFMAMJJASOND"[month - 1]!;
  })].join("");
  const rows = HEATMAP_ROW_LABELS.map((label, day) => {
    const cells = weeks.map((week) => HEATMAP_GLYPHS[week.levels[day] ?? 0] ?? ".").join("");
    return `${label.padEnd(4)}${cells}`;
  });
  return { header, rows, legend: `Less ${HEATMAP_GLYPHS.split("").join(" ")} More` };
}

export interface LimitsConfig {
  /** Cap for the "Current session" bar (most recent session file). */
  sessionTokens?: number;
  /** Cap for the "Today" bar. */
  dailyTokens?: number;
  /** Cap for the rolling 7-day "This week" bar. */
  weeklyTokens?: number;
  /** Cap for the month-to-date "This month" bar. */
  monthlyTokens?: number;
  /** Optional USD budget bar (month-to-date cost). Hidden when unset. */
  monthlyBudgetUsd?: number;
}

export const DEFAULT_LIMITS: LimitsConfig = {
  sessionTokens: 1_000_000,
  dailyTokens: 1_000_000,
  weeklyTokens: 5_000_000,
  monthlyTokens: 15_000_000,
};

/** Parse a `usageLimits` object (e.g. from settings.json). Missing or
 * non-numeric positive fields fall back to `DEFAULT_LIMITS`. */
export function parseLimitsConfig(value: unknown): LimitsConfig {
  const out: LimitsConfig = { ...DEFAULT_LIMITS };
  if (!value || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  for (const key of ["sessionTokens", "dailyTokens", "weeklyTokens", "monthlyTokens", "monthlyBudgetUsd"] as const) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) out[key] = raw;
  }
  return out;
}

export interface UsageLimitRow {
  title: string;
  /** 0..100+, Claude Code shows floor(utilization). */
  percent: number;
  usedText: string;
  resetText: string;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Rows for the plan-limit section, modeled on Claude Code's Usage settings:
 * Current session / Today / This week / This month, plus an optional budget
 * bar when `monthlyBudgetUsd` is configured. Limits come from the *full*
 * report; the interactive view overlays period slicing on breakdowns only. */
export function limitRows(report: MergedUsage, config: LimitsConfig, nowMs: number): UsageLimitRow[] {
  const now = new Date(nowMs);
  const rows: UsageLimitRow[] = [];
  const percent = (used: number, limit: number): number => (limit > 0 ? Math.floor((used / limit) * 100) : 0);
  const tokenText = (used: number, limit: number): string => `${formatTokens(used)} / ${formatTokens(limit)} tokens`;

  const sessionTokens = report.sessions[0]?.totalTokens ?? 0;
  rows.push({
    title: "Current session",
    percent: percent(sessionTokens, config.sessionTokens ?? DEFAULT_LIMITS.sessionTokens ?? 1_000_000),
    usedText: tokenText(sessionTokens, config.sessionTokens ?? DEFAULT_LIMITS.sessionTokens ?? 1_000_000),
    resetText: "rolling window",
  });

  const today = report.byDay.get(dayKey(nowMs))?.totalTokens ?? 0;
  rows.push({
    title: "Today",
    percent: percent(today, config.dailyTokens ?? DEFAULT_LIMITS.dailyTokens ?? 1_000_000),
    usedText: tokenText(today, config.dailyTokens ?? DEFAULT_LIMITS.dailyTokens ?? 1_000_000),
    resetText: "resets at end of day",
  });

  const weekFloor = dayKey(nowMs - 7 * DAY_MS);
  const weekTokens = [...report.byDay.entries()]
    .filter(([day]) => day >= weekFloor)
    .reduce((sum, [, usage]) => sum + usage.totalTokens, 0);
  rows.push({
    title: "This week",
    percent: percent(weekTokens, config.weeklyTokens ?? DEFAULT_LIMITS.weeklyTokens ?? 5_000_000),
    usedText: tokenText(weekTokens, config.weeklyTokens ?? DEFAULT_LIMITS.weeklyTokens ?? 5_000_000),
    resetText: "rolling 7-day window",
  });

  const monthPrefix = dayKey(nowMs).slice(0, 7);
  const monthTokens = [...report.byDay.entries()]
    .filter(([day]) => day.startsWith(monthPrefix))
    .reduce((sum, [, usage]) => sum + usage.totalTokens, 0);
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  rows.push({
    title: "This month",
    percent: percent(monthTokens, config.monthlyTokens ?? DEFAULT_LIMITS.monthlyTokens ?? 15_000_000),
    usedText: tokenText(monthTokens, config.monthlyTokens ?? DEFAULT_LIMITS.monthlyTokens ?? 15_000_000),
    resetText: `resets ${MONTH_NAMES[now.getUTCMonth()]} ${monthEnd.getUTCDate()}`, // e.g. "resets Aug 31"
  });

  if (config.monthlyBudgetUsd !== undefined) {
    const monthCost = [...report.byDay.entries()]
      .filter(([day]) => day.startsWith(monthPrefix))
      .reduce((sum, [, usage]) => sum + usage.cost, 0);
    rows.push({
      title: "Monthly budget",
      percent: percent(monthCost, config.monthlyBudgetUsd),
      usedText: `$${monthCost.toFixed(2)} / $${config.monthlyBudgetUsd.toFixed(2)}`,
      resetText: `resets ${MONTH_NAMES[now.getUTCMonth()]} ${monthEnd.getUTCDate()}`,
    });
  }

  return rows;
}

// Progress bar glyphs from Claude Code's design system:
// BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] — full blocks, at
// most one partial block, the rest empty. Ratio is clamped to [0, 1].
export const PROGRESS_BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

export interface BarSegments {
  /** Count of full █ blocks. */
  whole: number;
  /** Single partial block (" " when the remainder rounds to zero). */
  partial: string;
  /** Count of empty trailing cells. */
  empty: number;
}

export function progressBarSegments(ratio: number, width: number): BarSegments {
  const r = Math.min(1, Math.max(0, ratio));
  const w = Math.max(1, Math.floor(width));
  const whole = Math.floor(r * w);
  if (whole >= w) return { whole: w, partial: "", empty: 0 };
  const partial = PROGRESS_BLOCKS[Math.floor((r * w - whole) * PROGRESS_BLOCKS.length)] ?? " ";
  return { whole, partial, empty: Math.max(0, w - whole - 1) };
}

export function progressBarText(ratio: number, width: number): string {
  const { whole, partial, empty } = progressBarSegments(ratio, width);
  return "█".repeat(whole) + partial + " ".repeat(empty);
}

export type DrillKind = "model" | "tool" | "subagent" | "session";

export interface ChartPoint {
  readonly date: string;
  readonly tokens: number;
}

/** Immutable row model rendered by the TUI view; `ratio` is already
 * normalized against the section max so width-dependent scaling stays in the
 * view. */
export type UsageRow =
  | { kind: "section"; label: string }
  | { kind: "limit"; title: string; percent: number; usedText: string; resetText: string }
  | { kind: "quota"; title: string; percent: number; usedText: string; resetText: string }
  | { kind: "item"; label: string; ratio: number; detail: string; drill: DrillKind; key: string }
  | { kind: "chart"; title: string; points: readonly ChartPoint[] }
  | { kind: "heatmap"; title: string; weeks: readonly HeatmapWeek[] }
  | { kind: "stats"; entries: readonly { label: string; value: string }[] }
  | { kind: "stepchart"; title: string; dates: readonly string[]; series: readonly { label: string; values: readonly number[]; color: number }[] }
  | { kind: "modelcard"; label: string; percent: string; detail: string; color: number }
  | { kind: "info"; text: string };

export interface ViewData {
  cwd: string;
  period: Period;
  sessionsCount: number;
  skipped: number;
  totals: UsageTotals;
  limits: UsageLimitRow[];
  rows: UsageRow[];
  modelRows: UsageRow[];
}

function itemRows(
  rows: UsageRow[],
  label: string,
  entries: { key: string; label: string; value: number; detail: string; drill: DrillKind }[],
  maxValue: number,
  limit: number,
  moreLabel: string,
): void {
  rows.push({ kind: "section", label });
  for (const entry of entries.slice(0, limit)) {
    rows.push({
      kind: "item",
      label: entry.label,
      ratio: maxValue > 0 ? entry.value / maxValue : 0,
      detail: entry.detail,
      drill: entry.drill,
      key: entry.key,
    });
  }
  if (entries.length > limit) rows.push({ kind: "info", text: `+${entries.length - limit} more` });
}

export function shortModelName(key: string): string {
  const name = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function streakCounts(days: readonly string[]): { longest: number; current: number } {
  if (days.length === 0) return { longest: 0, current: 0 };
  const sorted = [...days].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = dayDiff(sorted[i - 1]!, sorted[i]!) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  let current = 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (dayDiff(sorted[i - 1]!, sorted[i]!) !== 1) break;
    current += 1;
  }
  return { longest, current };
}

export function buildOverviewStats(report: MergedUsage): { label: string; value: string }[] {
  const models = [...report.byModel.entries()].sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  const favorite = models[0]?.[0] ? shortModelName(models[0][0]) : "—";
  const activeDays = [...report.byDay.entries()].filter(([, usage]) => usage.totalTokens > 0);
  const activeKeys = activeDays.map(([day]) => day).sort();
  const spanDays = activeKeys.length === 0 ? 0 : dayDiff(activeKeys[0]!, activeKeys.at(-1)!) + 1;
  const mostActive = activeDays.sort((a, b) => b[1].totalTokens - a[1].totalTokens)[0]?.[0] ?? "—";
  let longestMs = 0;
  for (const session of report.sessions) {
    if (!session.startedAt || !session.lastAt) continue;
    const ms = Date.parse(session.lastAt) - Date.parse(session.startedAt);
    if (Number.isFinite(ms) && ms > longestMs) longestMs = ms;
  }
  const streaks = streakCounts(activeKeys);
  return [
    { label: "Favorite model", value: favorite },
    { label: "Total tokens", value: formatTokens(report.totals.totalTokens) },
    { label: "Sessions", value: String(report.sessions.length) },
    { label: "Longest session", value: formatDuration(longestMs) },
    { label: "Active days", value: spanDays > 0 ? `${activeKeys.length}/${spanDays}` : "0" },
    { label: "Longest streak", value: `${streaks.longest} day${streaks.longest === 1 ? "" : "s"}` },
    { label: "Most active day", value: mostActive },
    { label: "Current streak", value: `${streaks.current} day${streaks.current === 1 ? "" : "s"}` },
  ];
}

const CHART_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatChartDate(date: string): string {
  const parts = date.split("-");
  const month = CHART_MONTHS[Number(parts[1]) - 1];
  const day = Number(parts[2]);
  if (!month || !Number.isFinite(day)) return date;
  return `${month} ${day}`;
}

export function meterSegments(ratio: number, width: number): { filled: number; empty: number } {
  const w = Math.max(4, Math.floor(width));
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * w);
  return { filled, empty: Math.max(0, w - filled) };
}

export function renderMeter(ratio: number, width: number): string {
  const { filled, empty } = meterSegments(ratio, width);
  return `${"█".repeat(filled)}${"─".repeat(empty)}`;
}

/** Repeat each daily sample so outline plateaus look like Claude Code boxes. */
export function widenSeries(values: readonly number[], columnsPerDay: number): number[] {
  const width = Math.max(1, Math.floor(columnsPerDay));
  return values.flatMap((value) => Array.from({ length: width }, () => value));
}

/** Never stretch a day across the whole terminal — empty days become a sea of spaces. */
export function chartColumnsPerDay(dayCount: number, chartWidth: number): number {
  if (dayCount <= 0 || chartWidth <= 0) return 1;
  return Math.min(2, Math.max(1, Math.floor(chartWidth / dayCount)));
}

/** Drop leading all-zero days so a single spike is not glued to the right edge. */
export function trimLeadingZeroDays(
  dates: readonly string[],
  series: readonly { readonly values: readonly number[] }[],
): number {
  let start = 0;
  while (start < dates.length - 1 && series.every((item) => (item.values[start] ?? 0) <= 0)) start += 1;
  return start;
}

export function modelChartDates(
  byDay: ReadonlyMap<string, UsageTotals>,
  period: Period,
  nowMs: number,
): string[] {
  if (period !== "all") return dailyChartPoints(byDay, chartDayCount(period), nowMs).map((point) => point.date);
  const active = [...byDay.entries()].filter(([, usage]) => usage.totalTokens > 0).map(([day]) => day).sort();
  if (active.length === 0) return dailyChartPoints(byDay, 14, nowMs).map((point) => point.date);
  const firstMs = Date.parse(`${active[0]}T00:00:00Z`);
  const span = Number.isFinite(firstMs) ? Math.max(1, Math.round((nowMs - firstMs) / DAY_MS) + 1) : 14;
  return dailyChartPoints(byDay, Math.min(40, Math.max(7, span)), nowMs).map((point) => point.date);
}

/** Palette assigned by rank (most tokens first), never by model name. */
export const SERIES_COLORS = ["accent", "syntaxFunction", "warning", "success", "syntaxNumber", "error"] as const;
export type SeriesColor = (typeof SERIES_COLORS)[number];

export function seriesColorAt(index: number): SeriesColor {
  const n = SERIES_COLORS.length;
  return SERIES_COLORS[((index % n) + n) % n]!;
}

function seriesHeights(values: readonly number[], rows: number, max: number): number[] {
  return values.map((value) => (value <= 0 ? 0 : Math.max(1, Math.round((value / max) * rows))));
}

function putGlyph(grid: string[][], row: number, col: number, ch: string): void {
  if (row < 0 || col < 0 || row >= grid.length || col >= (grid[0]?.length ?? 0)) return;
  grid[row]![col] = ch;
}

// Box-drawing cells are composed from connections instead of treated as
// opaque characters. This lets multiple model series share a cell without a
// later series erasing the earlier series' vertical or horizontal segment.
const GLYPH_CONNECTIONS: Readonly<Record<string, number>> = {
  "─": 0b1010,
  "│": 0b0101,
  "┌": 0b0110,
  "┐": 0b1100,
  "└": 0b0011,
  "┘": 0b1001,
  "├": 0b0111,
  "┤": 0b1101,
  "┬": 0b1110,
  "┴": 0b1011,
  "┼": 0b1111,
};

const CONNECTION_GLYPHS: Readonly<Record<number, string>> = {
  0: " ",
  1: "│",
  2: "─",
  3: "└",
  4: "│",
  5: "│",
  6: "┌",
  7: "├",
  8: "─",
  9: "┘",
  10: "─",
  11: "┴",
  12: "┐",
  13: "┤",
  14: "┬",
  15: "┼",
};

function glyphForConnections(connections: number): string {
  return CONNECTION_GLYPHS[connections & 0b1111] ?? " ";
}

/** Claude Code-style outline step chart: plateaus connected by verticals, never filled █. */
export function renderStepChart(values: readonly number[], height = 8, maxValue?: number): string[] {
  const rows = Math.max(2, Math.floor(height));
  const samples = values.length === 0 ? [0] : values;
  const cols = Math.max(1, samples.length);
  const max = Math.max(1, maxValue ?? Math.max(0, ...samples));
  const hs = seriesHeights(samples, rows, max);
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  const topRow = (h: number): number => rows - h;

  for (let i = 0; i < hs.length; i++) {
    const h = hs[i]!;
    if (h > 0) putGlyph(grid, topRow(h), i, "─");
  }
  if ((hs[0] ?? 0) > 0) putGlyph(grid, topRow(hs[0]!), 0, "┌");

  for (let i = 0; i < hs.length - 1; i++) {
    const h = hs[i]!;
    const next = hs[i + 1]!;
    if (next === h) continue;
    if (next > h) {
      if (h > 0) putGlyph(grid, topRow(h), i, "┘");
      for (let y = h + 1; y <= next; y++) putGlyph(grid, topRow(y), i, "│");
      putGlyph(grid, topRow(next), i, "┌");
    } else {
      putGlyph(grid, topRow(h), i, "┐");
      for (let y = h - 1; y > next; y--) putGlyph(grid, topRow(y), i, "│");
      if (next > 0) putGlyph(grid, topRow(next), i, "└");
      else for (let y = h - 1; y >= 1; y--) putGlyph(grid, topRow(y), i, "│");
    }
  }
  return grid.map((row) => row.join(""));
}

export function renderOutlineChart(
  series: readonly (readonly number[])[],
  height = 8,
): { lines: string[]; owner: number[][] } {
  const rows = Math.max(2, Math.floor(height));
  const cols = Math.max(1, ...series.map((item) => item.length), 1);
  const max = Math.max(1, ...series.flatMap((item) => [...item]));
  const connections = Array.from({ length: rows }, () => Array(cols).fill(0));
  const owner = Array.from({ length: rows }, () => Array(cols).fill(-1));

  // Draw low-priority series first for deterministic ownership, then keep the
  // lowest index when cells overlap because the series are ranked by usage.
  for (let s = series.length - 1; s >= 0; s--) {
    const padded = [...series[s]!];
    while (padded.length < cols) padded.push(0);
    const drawn = renderStepChart(padded, rows, max);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const mask = GLYPH_CONNECTIONS[drawn[r]![c] ?? " "] ?? 0;
        if (mask === 0) continue;
        connections[r]![c] |= mask;
        if (owner[r]![c] === -1 || s < owner[r]![c]!) owner[r]![c] = s;
      }
    }
  }

  return {
    lines: connections.map((row) => row.map(glyphForConnections).join("")),
    owner,
  };
}

export function yAxisLabels(max: number, height: number): string[] {
  const rows = Math.max(2, Math.floor(height));
  const width = Math.max(formatTokens(max).length, formatTokens(0).length);
  return Array.from({ length: rows }, (_, row) => {
    const value = Math.round(max * ((rows - row) / rows));
    return formatTokens(value).padStart(width);
  });
}

export function xAxisDateLine(dates: readonly string[], width: number): string {
  if (dates.length === 0 || width < 1) return "";
  const picks = dates.length <= 4
    ? dates.map((date, index) => ({ index, text: formatChartDate(date) }))
    : [0, Math.floor(dates.length / 3), Math.floor((2 * dates.length) / 3), dates.length - 1].map((index) => ({
        index,
        text: formatChartDate(dates[index]!),
      }));
  const lineWidth = Math.max(1, Math.floor(width));
  const longestLabel = Math.max(1, ...picks.map((pick) => pick.text.length));
  const labelCount = Math.max(1, Math.min(picks.length, Math.floor((lineWidth + 1) / (longestLabel + 1))));
  const selected = labelCount === 1
    ? [picks[picks.length - 1]!]
    : Array.from({ length: labelCount }, (_, position) =>
        picks[Math.round((position * (picks.length - 1)) / (labelCount - 1))]!,
      );
  const layout = (labels: readonly { index: number; text: string }[]): string[] | undefined => {
    const cells = Array(lineWidth).fill(" ");
    let previousEnd = -1;
    for (const label of labels) {
      const text = label.text;
      if (text.length > lineWidth) return undefined;
      const maxStart = Math.max(0, lineWidth - text.length);
      const desired = dates.length === 1
        ? maxStart
        : Math.round((label.index * maxStart) / (dates.length - 1));
      let start = Math.max(previousEnd + 1, desired);
      if (start > maxStart) start = maxStart;
      if (start <= previousEnd) return undefined;
      for (let i = 0; i < text.length; i++) cells[start + i] = text[i]!;
      previousEnd = start + text.length - 1;
    }
    return cells;
  };
  let visible = selected;
  while (visible.length > 1) {
    const rendered = layout(visible);
    if (rendered) return rendered.join("").trimEnd();
    visible = [visible[0]!, visible[visible.length - 1]!];
  }
  return (layout(visible) ?? []).join("").trimEnd();
}

/** Overview: heatmap + stats grid. Plan-limit bars live on Quota. */
export function buildViewRows(
  report: MergedUsage,
  _limits: UsageLimitRow[],
  options?: { period?: Period; nowMs?: number },
): UsageRow[] {
  const rows: UsageRow[] = [];
  const nowMs = options?.nowMs ?? Date.now();
  const period = options?.period ?? "7d";
  const weeks = activityHeatmap(report.byDay, heatmapWeekCount(period), nowMs);
  if (weeks.some((week) => week.levels.some((level) => level > 0))) {
    rows.push({ kind: "heatmap", title: "", weeks });
  }
  const stats = buildOverviewStats(report);
  if (report.sessions.length > 0) rows.push({ kind: "stats", entries: stats });
  return rows;
}

/** Models pane: outline tokens-per-day chart plus In/Out cards. */
export function buildModelViewRows(
  report: MergedUsage,
  options?: { period?: Period; nowMs?: number },
): UsageRow[] {
  const rows: UsageRow[] = [];
  const nowMs = options?.nowMs ?? Date.now();
  const period = options?.period ?? "7d";
  const dates = modelChartDates(report.byDay, period, nowMs);
  const ranked = [...report.byModel.entries()].sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  const top = ranked.slice(0, 3);
  const series = top.map(([key], index) => ({
    label: shortModelName(key),
    values: dates.map((date) => report.byDayByModel.get(date)?.get(key)?.totalTokens ?? 0),
    color: index,
  }));
  const start = trimLeadingZeroDays(dates, series);
  const visibleDates = dates.slice(start);
  const visibleSeries = series.map((item) => ({ ...item, values: item.values.slice(start) }));
  if (top.length > 0 && visibleSeries.some((item) => item.values.some((value) => value > 0))) {
    rows.push({
      kind: "stepchart",
      title: "Tokens per Day",
      dates: visibleDates,
      series: visibleSeries,
    });
  }
  const total = report.totals.totalTokens;
  ranked.slice(0, 6).forEach(([key, usage], index) => {
    const percent = total > 0 ? ((usage.totalTokens / total) * 100).toFixed(1) : "0.0";
    rows.push({
      kind: "modelcard",
      label: shortModelName(key),
      percent: `${percent}%`,
      detail: `In: ${formatTokens(usage.input)} · Out: ${formatTokens(usage.output)}`,
      color: index,
    });
  });
  return rows;
}

/** Rows for the drill-down view (Enter from an item). `kind` + `key` pick the
 * dimension; "session" shows one file's models. Drilled models/tools keep
 * their own `drill` kind so the user can walk the chain and Backspace pops. */
export function drillRows(files: readonly FileSummary[], kind: DrillKind, key: string): UsageRow[] {
  const rows: UsageRow[] = [];
  const fileLabel = (file: string): string => file.split(/[\\/]/).pop() ?? file;

  if (kind === "model") {
    const entries = files
      .map((file) => ({ file, usage: file.byModel.get(key) }))
      .filter((e): e is { file: FileSummary; usage: ModelUsage } => e.usage !== undefined)
      .map(({ file, usage }) => ({
        key: file.file,
        label: fileLabel(file.file),
        value: usage.totalTokens,
        detail: `${usage.calls} calls · $${modelCost(key, usage).toFixed(2)}`,
        drill: "session" as const,
      }))
      .sort((a, b) => b.value - a.value);
    itemRows(rows, `Model ${key}`, entries, entries[0]?.value ?? 0, 10, "files");
    return rows;
  }

  const usageOf = (
    file: FileSummary,
    kindOf: "tool" | "subagent",
  ): { file: FileSummary; usage: ToolUsage } | undefined => {
    const usage = kindOf === "tool" ? file.byTool.get(key) : file.bySubagent.get(key);
    return usage ? { file, usage } : undefined;
  };
  const byCalls = (kindOf: "tool" | "subagent") =>
    files
      .map((file) => usageOf(file, kindOf))
      .filter((e): e is { file: FileSummary; usage: ToolUsage } => e !== undefined)
      .map(({ file, usage }) => ({
        key: file.file,
        label: fileLabel(file.file),
        value: usage.calls,
        detail:
          (usage.errors > 0 ? `${usage.calls} (${usage.errors} err)` : `${usage.calls} calls`) +
          (usage.totalTokens > 0 ? ` · ${formatTokens(usage.totalTokens)}` : ""),
        drill: "session" as const,
      }))
      .sort((a, b) => b.value - a.value);

  if (kind === "tool") {
    const entries = byCalls("tool");
    itemRows(rows, `Tool ${key}`, entries, entries[0]?.value ?? 0, 10, "files");
    return rows;
  }
  if (kind === "subagent") {
    const entries = byCalls("subagent");
    itemRows(rows, `Subagent ${key}`, entries, entries[0]?.value ?? 0, 10, "files");
    return rows;
  }

  const file = files.find((f) => f.file === key);
  if (!file) {
    rows.push({ kind: "info", text: `Session not found: ${key}` });
    return rows;
  }
  rows.push({
    kind: "info",
    text: `Session ${fileLabel(key)} · started ${file.startedAt ?? "?"} · ${formatTokens(file.totals.totalTokens)} tokens · $${file.totals.cost.toFixed(2)}`,
  });
  const models = [...file.byModel.entries()]
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    .map(([keyM, usage]) => ({
      key: keyM,
      label: keyM,
      value: usage.totalTokens,
      detail: `${usage.calls} calls · $${modelCost(keyM, usage).toFixed(2)}`,
      drill: "model" as const,
    }));
  itemRows(rows, "By model", models, models[0]?.value ?? 0, 8, "models");
  return rows;
}

// ---------------------------------------------------------------------------
// Tabs and remote quota (Quota / Sessions tabs) — pure parsing and row
// building. Network and credential discovery live in providers.ts; nothing
// here touches the filesystem or the network.
// ---------------------------------------------------------------------------

export type TabId = "usage" | "quota" | "sessions";

export const TAB_LABELS: Readonly<Record<TabId, string>> = {
  usage: "Usage",
  quota: "Quota",
  sessions: "Sessions",
};

/** "resets in …" text from a future epoch-ms timestamp (past -> "now"). */
export function formatResetsAt(resetAtMs: number, nowMs: number): string {
  const ms = resetAtMs - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return "resets now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export interface CodexWindow {
  /** "5h" or "weekly", derived from `limit_window_seconds`; falls back to
   * the server key name for unknown durations. */
  label: string;
  /** 0..100, server-reported. */
  usedPercent: number;
  /** Epoch ms of the next reset. */
  resetsAtMs: number;
}

export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

export type CodexQuota =
  | {
      source: "live";
      planType?: string;
      email?: string;
      windows: CodexWindow[];
      credits?: CodexCredits;
      rateLimitReached?: string;
    }
  | { source: "unavailable"; error?: string };

function codexWindow(raw: unknown, fallbackLabel: string): CodexWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const used = record.used_percent;
  if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
  const msRaw = record.reset_time_ms ?? record.reset_at;
  if (typeof msRaw !== "number" || !Number.isFinite(msRaw)) return undefined;
  const seconds = record.limit_window_seconds;
  const label =
    typeof seconds === "number" && Number.isFinite(seconds)
      ? seconds <= 6 * 3600
        ? "5h"
        : seconds >= 6 * 24 * 3600
          ? "weekly"
          : fallbackLabel
      : fallbackLabel;
  return { label, usedPercent: used, resetsAtMs: record.reset_time_ms !== undefined ? msRaw : msRaw * 1000 };
}

/** Parse the body of `GET /backend-api/wham/usage` (ChatGPT/Codex backend,
 * same shape the codex web usage settings and community quota tools consume).
 * Tolerant of the observed aliases (`rate_limit.primary_window` vs top-level
 * `five_hour`/`weekly`). Returns null when nothing usable is present. */
export function parseCodexUsageJson(value: unknown): CodexQuota | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rateLimit = (record.rate_limit ?? {}) as Record<string, unknown>;
  const planType = typeof record.plan_type === "string" ? record.plan_type : undefined;

  const windows: CodexWindow[] = [];
  const primary = codexWindow(rateLimit.primary_window ?? record.five_hour ?? record.primary, "primary");
  if (primary) windows.push(primary);
  const secondary = codexWindow(rateLimit.secondary_window ?? record.weekly ?? record.secondary, "secondary");
  if (secondary) windows.push(secondary);

  let credits: CodexCredits | undefined;
  const creditsRaw = record.credits;
  if (creditsRaw && typeof creditsRaw === "object") {
    const c = creditsRaw as Record<string, unknown>;
    credits = {
      hasCredits: c.has_credits === true,
      unlimited: c.unlimited === true,
      balance: typeof c.balance === "string" ? c.balance : undefined,
    };
  }

  const reached = record.rate_limit_reached_type;
  if (windows.length === 0 && planType === undefined && !credits) return null;
  return {
    planType,
    windows,
    credits,
    rateLimitReached: typeof reached === "string" && reached !== "" ? reached : undefined,
    source: "live",
  };
}

const PLAN_NAMES: Readonly<Record<string, string>> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

export interface ChatgptIdClaims {
  email?: string;
  planType?: string;
  accountId?: string;
}

function base64UrlDecode(payload: string): string | undefined {
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.length % 4 === 0 ? b64 : b64.padEnd(b64.length + (4 - (b64.length % 4)), "=");
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

/** Decode the `id_token` JWT stored in ~/.codex/auth.json (payload claims
 * only — the signature is not verified; the token is only used to label the
 * account that owns the access token with its plan/email). */
export function decodeChatgptIdToken(jwt: string): ChatgptIdClaims {
  const claims: ChatgptIdClaims = {};
  const payload = typeof jwt === "string" ? jwt.split(".")[1] : undefined;
  if (!payload) return claims;
  const json = base64UrlDecode(payload);
  if (!json) return claims;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return claims;
  }
  if (typeof parsed.email === "string") claims.email = parsed.email;
  const profile = parsed["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
  if (claims.email === undefined && profile && typeof profile.email === "string") claims.email = profile.email;
  const auth = parsed["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  if (auth && typeof auth === "object") {
    const plan = auth.chatgpt_plan_type;
    if (typeof plan === "string") claims.planType = PLAN_NAMES[plan] ?? plan;
    const account = auth.chatgpt_account_id;
    if (typeof account === "string") claims.accountId = account;
  }
  return claims;
}

export interface GoWindow {
  kind: "rolling" | "weekly" | "monthly";
  status: "ok" | "rate-limited";
  /** 0..100, server-computed (floored, capped at 100). */
  percent: number;
  /** ISO timestamp of the next reset. */
  resetsAt: string;
}

export type GoQuota =
  | { source: "live"; windows: GoWindow[] }
  | { source: "unavailable"; error?: string };

/** OpenCode Go plan display limits (from opencode's `lite` plan schema). */
export const GO_PLAN_LIMITS: Readonly<Record<GoWindow["kind"], { usd: number; label: string }>> = {
  rolling: { usd: 12, label: "$12" },
  weekly: { usd: 30, label: "$30" },
  monthly: { usd: 60, label: "$60" },
};

/** Parse the body of `GET https://opencode.ai/zen/go/v1/usage`. */
export function parseGoUsageJson(value: unknown): GoQuota | null {
  if (!value || typeof value !== "object") return null;
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const windows: GoWindow[] = [];
  for (const kind of ["rolling", "weekly", "monthly"] as const) {
    const raw = record[kind];
    if (!raw || typeof raw !== "object") continue;
    const win = raw as Record<string, unknown>;
    const status = win.status;
    if (status !== "ok" && status !== "rate-limited") continue;
    const percent = win.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    const resetsAt = win.resetsAt;
    if (typeof resetsAt !== "string" || resetsAt === "") continue;
    windows.push({ kind, status, percent, resetsAt });
  }
  if (windows.length === 0) return null;
  return { windows, source: "live" };
}

export interface XaiWindow {
  title: string;
  percent: number;
  usedText: string;
  /** Epoch ms of the next reset, when the server reports one. */
  resetsAtMs?: number;
}

export type XaiQuota =
  | {
      source: "live";
      mode: "subscription" | "api";
      label?: string;
      windows: XaiWindow[];
      notes: string[];
    }
  | { source: "unavailable"; error?: string };

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** `{ val }` money wrappers from Grok billing are USD cents. */
function centsToUsd(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const amount = finiteNumber((value as Record<string, unknown>).val);
  return amount === undefined ? undefined : amount / 100;
}

function isoToMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function xaiPeriodTitle(type: string | undefined): string {
  if (type === "USAGE_PERIOD_TYPE_MONTHLY") return "Monthly";
  if (type === "USAGE_PERIOD_TYPE_DAILY") return "Daily";
  return "Weekly";
}

/** Parse `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
 * (Grok/X subscription). Tolerates the legacy monthly-limit shape. */
export function parseXaiBillingJson(value: unknown): XaiQuota | null {
  if (!value || typeof value !== "object") return null;
  const config = (value as Record<string, unknown>).config;
  if (!config || typeof config !== "object") return null;
  const record = config as Record<string, unknown>;
  const windows: XaiWindow[] = [];
  const notes: string[] = [];

  const period = record.currentPeriod;
  const periodRecord = period && typeof period === "object" ? (period as Record<string, unknown>) : undefined;
  const periodType = typeof periodRecord?.type === "string" ? periodRecord.type : undefined;
  const resetsAtMs = isoToMs(periodRecord?.end) ?? isoToMs(record.billingPeriodEnd);
  const percent = finiteNumber(record.creditUsagePercent);
  if (percent !== undefined || periodType !== undefined) {
    const used = Math.min(100, Math.max(0, percent ?? 0));
    windows.push({
      title: xaiPeriodTitle(periodType),
      percent: used,
      usedText: `${Math.floor(used)}% used`,
      resetsAtMs,
    });
  }

  const monthlyLimit = centsToUsd(record.monthlyLimit);
  const monthlyUsed = centsToUsd(record.used);
  if (monthlyLimit !== undefined && monthlyUsed !== undefined && monthlyLimit > 0) {
    windows.push({
      title: "Monthly allowance",
      percent: (monthlyUsed / monthlyLimit) * 100,
      usedText: `${formatUsd(monthlyUsed)} / ${formatUsd(monthlyLimit)}`,
      resetsAtMs: isoToMs(record.billingPeriodEnd) ?? resetsAtMs,
    });
  }

  const prepaid = centsToUsd(record.prepaidBalance);
  if (prepaid !== undefined && prepaid > 0) notes.push(`Prepaid: ${formatUsd(prepaid)} remaining`);

  const onDemandCap = centsToUsd(record.onDemandCap);
  const onDemandUsed = centsToUsd(record.onDemandUsed) ?? 0;
  if (onDemandCap !== undefined && onDemandCap > 0) {
    windows.push({
      title: "On-demand",
      percent: (onDemandUsed / onDemandCap) * 100,
      usedText: `${formatUsd(onDemandUsed)} / ${formatUsd(onDemandCap)}`,
    });
  }

  if (windows.length === 0 && notes.length === 0) return null;
  return { source: "live", mode: "subscription", windows, notes };
}

/** Parse `GET https://api.x.ai/v1/api-key`. Credit fields are optional on the
 * official schema; when present they are USD. */
export function parseXaiApiKeyJson(value: unknown): XaiQuota | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const remaining = finiteNumber(record.remaining_balance);
  const spent = finiteNumber(record.spent_balance);
  const granted = finiteNumber(record.total_granted);
  const name = typeof record.name === "string" && record.name !== "" ? record.name : undefined;
  const blocked =
    record.api_key_blocked === true || record.api_key_disabled === true || record.team_blocked === true;
  const looksLikeKey =
    name !== undefined || "acls" in record || "api_key_id" in record || "redacted_api_key" in record;

  const windows: XaiWindow[] = [];
  const notes: string[] = [];
  if (blocked) notes.push("API key or team is blocked");

  if (granted !== undefined && granted > 0) {
    const used = spent ?? (remaining !== undefined ? Math.max(0, granted - remaining) : 0);
    windows.push({
      title: "Credits",
      percent: (used / granted) * 100,
      usedText:
        remaining !== undefined
          ? `${formatUsd(remaining)} remaining · of ${formatUsd(granted)}`
          : `${formatUsd(used)} / ${formatUsd(granted)}`,
    });
  } else if (remaining !== undefined) {
    notes.push(`${formatUsd(remaining)} remaining`);
  }

  if (windows.length === 0 && notes.length === 0 && !looksLikeKey) return null;
  if (windows.length === 0 && notes.length === 0) notes.push("API key active — no credit balance reported");
  return { source: "live", mode: "api", label: name, windows, notes };
}

export interface QuotaRowData {
  codex: CodexQuota;
  go: GoQuota;
  xai: XaiQuota;
  /** Whether any opencode (Zen free tier) model shows usage in this project. */
  zenUsed: boolean;
  nowMs: number;
}

function quotaLimitRow(title: string, percent: number, usedText: string, resetText: string): Extract<UsageRow, { kind: "quota" }> {
  return { kind: "quota", title, percent, usedText, resetText };
}

/** Body rows for the Quota tab: server-reported windows for the Codex
 * (ChatGPT subscription), OpenCode Go, and xAI plans, plus graceful notes
 * when a credential or endpoint is missing. Percent is floored like Claude Code. */
export function buildQuotaRows(data: QuotaRowData): UsageRow[] {
  const rows: UsageRow[] = [];
  const { codex, go, xai, nowMs } = data;
  const pct = (value: number): number => Math.min(100, Math.floor(value));

  rows.push({ kind: "section", label: "Codex (ChatGPT subscription)" });
  if (codex.source === "live") {
    for (const window of codex.windows) {
      rows.push(
        quotaLimitRow(
          `${window.label} quota`,
          pct(window.usedPercent),
          `${pct(window.usedPercent)}% used`,
          formatResetsAt(window.resetsAtMs, nowMs),
        ),
      );
    }
    if (codex.rateLimitReached) {
      rows.push({
        kind: "info",
        text: `Rate limit reached (${codex.rateLimitReached}) — further requests are blocked until reset`,
      });
    }
    if (codex.credits?.hasCredits) {
      rows.push({
        kind: "info",
        text: codex.credits.unlimited ? "Extra usage: unlimited" : `Extra usage: ${codex.credits.balance ?? "available"}`,
      });
    }
  } else {
    rows.push({ kind: "info", text: codex.error ?? "Codex quota unavailable." });
  }

  rows.push({ kind: "section", label: "OpenCode Go" });
  if (go.source === "live") {
    for (const window of go.windows) {
      const limit = GO_PLAN_LIMITS[window.kind];
      const used = pct(window.percent);
      const title = window.kind === "rolling" ? "5h rolling" : window.kind === "weekly" ? "Weekly" : "Monthly";
      rows.push(
        quotaLimitRow(title, used, `${used}% used · of ${limit.label}`, formatResetsAt(Date.parse(window.resetsAt), nowMs)),
      );
      if (window.status === "rate-limited") {
        rows.push({ kind: "info", text: `Rate limited — ${window.kind} window exhausted until reset` });
      }
    }
  } else {
    rows.push({ kind: "info", text: go.error ?? "OpenCode Go quota unavailable." });
  }

  rows.push({ kind: "section", label: "xAI (Grok)" });
  if (xai.source === "live") {
    for (const window of xai.windows) {
      rows.push(
        quotaLimitRow(
          window.title,
          pct(window.percent),
          window.usedText,
          window.resetsAtMs !== undefined ? formatResetsAt(window.resetsAtMs, nowMs) : "prepaid balance",
        ),
      );
    }
    for (const note of xai.notes) rows.push({ kind: "info", text: note });
  } else {
    rows.push({ kind: "info", text: xai.error ?? "xAI quota unavailable." });
  }

  if (data.zenUsed) {
    rows.push({ kind: "section", label: "Zen free tier" });
    rows.push({ kind: "info", text: "opencode (Zen free) models are free — no quota to report" });
  }

  return rows;
}

/** Full session list for the Sessions tab (most recent first, capped at 20). */
export function buildSessionsTab(report: MergedUsage): UsageRow[] {
  const rows: UsageRow[] = [];
  const sessions = report.sessions.slice().sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  if (sessions.length === 0) {
    rows.push({ kind: "info", text: "No sessions." });
    return rows;
  }
  rows.push({
    kind: "stats",
    entries: [
      { label: "Sessions", value: String(sessions.length) },
      { label: "Total tokens", value: formatTokens(report.totals.totalTokens) },
    ],
  });
  const max = Math.max(...sessions.map((session) => session.totalTokens));
  const shown = sessions.slice(0, 20);
  for (const session of shown) {
    const label = session.file.split(/[\\/]/).pop() ?? session.file;
    const started = session.startedAt ? session.startedAt.slice(0, 10) : "unknown";
    const duration =
      session.startedAt && session.lastAt
        ? formatDuration(Date.parse(session.lastAt) - Date.parse(session.startedAt))
        : "—";
    const model = session.model ? shortModelName(session.model) : "—";
    rows.push({
      kind: "item",
      label,
      ratio: max > 0 ? session.totalTokens / max : 0,
      detail: `${started} · ${formatTokens(session.totalTokens)} · ${duration} · ${model}`,
      drill: "session",
      key: session.file,
    });
  }
  if (sessions.length > shown.length) rows.push({ kind: "info", text: `+${sessions.length - shown.length} more sessions` });
  return rows;
}