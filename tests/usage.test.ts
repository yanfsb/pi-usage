import { describe, expect, test } from "bun:test";
import {
  analyzeFile,
  buildViewRows,
  chartDayCount,
  dailyChartPoints,
  dailySeries,
  dayKey,
  DEFAULT_LIMITS,
  drillRows,
  encodeProjectDir,
  formatTokens,
  limitRows,
  mergeReports,
  parseLimitsConfig,
  parseUsage,
  periodSince,
  PROGRESS_BLOCKS,
  progressBarSegments,
  progressBarText,
  renderBars,
  activityHeatmap,
  buildModelViewRows,
  buildOverviewStats,
  cacheHitPercent,
  chartColumnsPerDay,
  formatDuration,
  heatmapLevel,
  heatmapWeekCount,
  renderDailyChartLines,
  formatChartDate,
  renderHeatmapLines,
  meterSegments,
  renderMeter,
  renderOutlineChart,
  renderStepChart,
  seriesColorAt,
  widenSeries,
  xAxisDateLine,
  renderReport,
  sparkline,
  trimLeadingZeroDays,
  weekdayLetter,
} from "../src/analyze.ts";
import type { UsageTotals } from "../src/analyze.ts";

const HEADER = `{"type":"session","version":3,"id":"uuid1","timestamp":"2026-08-17T03:30:27.800Z","cwd":"/some/project"}`;

const ASSISTANT_WITH_SUBAGENT = `{"type":"message","id":"a1","parentId":"h1","timestamp":"2026-08-17T03:31:00.000Z","message":{"role":"assistant","provider":"opencode","model":"deepseek-v4-flash-free","usage":{"input":1000,"output":2000,"cacheRead":30000,"cacheWrite":0,"totalTokens":33000,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","content":[{"type":"text","text":"plan"},{"type":"toolCall","id":"call_sub1","name":"subagent","arguments":{"agent":"reviewer","task":"review"}}]}}`;

const SUBAGENT_RESULT_OK = `{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-08-17T03:32:00.000Z","message":{"role":"toolResult","toolCallId":"call_sub1","toolName":"subagent","content":[{"type":"text","text":"done"}],"isError":false,"usage":{"input":5000,"output":1000,"cacheRead":0,"cacheWrite":0,"totalTokens":6000,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}`;

const ASSISTANT_PLAIN = `{"type":"message","id":"a2","parentId":"r1","timestamp":"2026-08-17T03:33:00.000Z","message":{"role":"assistant","provider":"opencode","model":"deepseek-v4-flash-free","usage":{"input":500,"output":500,"cacheRead":0,"cacheWrite":0,"totalTokens":1000,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","content":[{"type":"text","text":"ok"}]}}`;

const BASH_ERROR = `{"type":"message","id":"r2","parentId":"a2","timestamp":"2026-08-17T03:34:00.000Z","message":{"role":"toolResult","toolCallId":"call_b","toolName":"bash","content":[{"type":"text","text":"boom"}],"isError":true}}`;

const BASH_WITH_USAGE = `{"type":"message","id":"r3","parentId":"a2","timestamp":"2026-08-17T09:00:00.000Z","message":{"role":"toolResult","toolCallId":"call_b2","toolName":"bash","content":[{"type":"text","text":"ok"}],"isError":false,"usage":{"input":50,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":60,"cost":{"total":0}}}}`;

const COMPACTION = `{"type":"compaction","id":"c1","parentId":"r2","timestamp":"2026-08-17T03:35:00.000Z","summary":"summary","tokensBefore":50000,"usage":{"input":100,"output":100,"cacheRead":0,"cacheWrite":0,"totalTokens":200,"cost":{"total":0}}}`;

const MODEL_CHANGE = `{"type":"model_change","id":"m1","parentId":"h1","timestamp":"2026-08-17T03:30:30.000Z","provider":"opencode","modelId":"gpt-x"}`;

const GARBAGE = `not json { broken line`;

function mergeTotals(...usages: UsageTotals[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  for (const usage of usages) {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.totalTokens += usage.totalTokens;
    totals.cost += usage.cost;
  }
  return totals;
}

describe("usage encoding", () => {
  test("matches the on-disk project dir naming", () => {
    expect(encodeProjectDir("/Users/ybarbara/.pi/agent")).toBe("--Users-ybarbara-.pi-agent--");
    expect(encodeProjectDir("/a/b")).toBe("--a-b--");
    expect(encodeProjectDir("relative/path")).toBe("--relative-path--");
  });

  test("formats token counts compactly", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("2k");
    expect(formatTokens(1_234_000)).toBe("1.2M");
  });
});

describe("usage parsing", () => {
  test("parses usage objects and ignores malformed ones", () => {
    expect(parseUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 5, cost: { total: 1.5 } })).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 5,
      cost: 1.5,
    });
    expect(parseUsage(undefined)).toBeUndefined();
    expect(parseUsage({ input: "nope" })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
  });

  test("aggregates tokens, models, tools, subagents, and days per file", () => {
    const summary = analyzeFile("s1.jsonl", [
      HEADER,
      MODEL_CHANGE,
      ASSISTANT_WITH_SUBAGENT,
      SUBAGENT_RESULT_OK,
      ASSISTANT_PLAIN,
      BASH_ERROR,
      COMPACTION,
      GARBAGE,
    ]);

    expect(summary.totals.totalTokens).toBe(33000 + 1000 + 200);
    expect(summary.totals.cost).toBe(0);
    // Model attribution: assistant messages carry provider/model; compaction
    // usage falls back to the last seen model (opencode/deepseek-v4-flash-free,
    // since the change to gpt-x came before the first assistant message).
    const model = summary.byModel.get("opencode/deepseek-v4-flash-free");
    expect(model?.calls).toBe(2);
    expect(model?.totalTokens).toBe(33000 + 1000 + 200);

    expect(summary.byTool.get("subagent")).toEqual({ calls: 1, errors: 0, totalTokens: 6000, cost: 0 });
    expect(summary.byTool.get("bash")).toEqual({ calls: 1, errors: 1, totalTokens: 0, cost: 0 });
    expect(summary.bySubagent.get("reviewer")).toEqual({ calls: 1, errors: 0, totalTokens: 6000, cost: 0 });
    // All fixture entries are on 2026-08-17; nested subagent usage (6000) is
    // also attributed to the day.
    expect(summary.byDay.get("2026-08-17")?.totalTokens).toBe(33000 + 1000 + 200 + 6000);
    expect(summary.startedAt).toBe("2026-08-17T03:30:27.800Z");
    expect(summary.lastAt).toBe("2026-08-17T03:35:00.000Z");
  });

  test("nested toolResult usage lands in byTool and byDay", () => {
    const summary = analyzeFile("s2.jsonl", [HEADER, BASH_WITH_USAGE]);
    expect(summary.byTool.get("bash")).toEqual({ calls: 1, errors: 0, totalTokens: 60, cost: 0 });
    expect(summary.byDay.get("2026-08-17")?.totalTokens).toBe(60);
  });

  test("malformed lines and unknown entry types are skipped safely", () => {
    const summary = analyzeFile("s2.jsonl", [GARBAGE, `{"type":"label","label":"x"}`, "", MODEL_CHANGE]);
    expect(summary.totals.totalTokens).toBe(0);
    expect([...summary.byModel.keys()]).toHaveLength(0);
    expect([...summary.byTool.keys()]).toHaveLength(0);
  });

  test("compaction usage without a known model lands in its own bucket", () => {
    const summary = analyzeFile("s3.jsonl", [HEADER, COMPACTION]);
    expect(summary.byModel.get("summary")?.totalTokens).toBe(200);
    expect(summary.totals.totalTokens).toBe(200);
  });
});

describe("usage merge and render", () => {
  test("merges totals across files without double counting", () => {
    const a = analyzeFile("a.jsonl", [HEADER, ASSISTANT_WITH_SUBAGENT, SUBAGENT_RESULT_OK]);
    const b = analyzeFile("b.jsonl", [HEADER, ASSISTANT_PLAIN]);
    const merged = mergeReports([a, b]);

    const expectTokens = mergeTotals(a.totals, b.totals).totalTokens;
    expect(merged.totals.totalTokens).toBe(expectTokens);
    expect(merged.sessions).toHaveLength(2);
    expect(merged.byTool.get("subagent")?.calls).toBe(1);
    expect(merged.bySubagent.get("reviewer")?.calls).toBe(1);
    expect(merged.byDay.get("2026-08-17")?.totalTokens).toBe(33000 + 6000 + 1000);

    const text = renderReport({ cwd: "/some/project", ...merged });
    expect(text).toContain("Usage — /some/project");
    expect(text).toContain("2 sessions · 34k tokens total · $0.00");
    expect(text).toContain("Daily");
  });

  test("renders bars scaled to the requested width", () => {
    const bars = renderBars(
      [
        { label: "opencode/deepseek-v4-flash-free", value: 1000 },
        { label: "openai-codex/gpt-5.6-sol", value: 4000 },
        { label: "x", value: 0 },
      ],
      10,
    );
    expect(bars).toHaveLength(3);
    expect(bars[0]).toContain("█".repeat(3)); // 1000/4000 * 10 rounded
    expect(bars[1]).toContain("█".repeat(10));
    expect(bars[2]).not.toContain("█");
    expect(bars[2]).toContain("0");
  });

  test("renderBars gives tiny positive values at least one bar and clamps width", () => {
    const bars = renderBars([{ label: "a", value: 1 }, { label: "b", value: 1_000_000 }], 5);
    expect(bars[0]).toContain("█".repeat(1));
    expect(bars[1]).toContain("█".repeat(5));
  });

  test("sparkline right-aligns into width and renders empty input", () => {
    expect(sparkline([], 10)).toBe("");
    const series = [0, 10, 40, 100, 30];
    const line = sparkline(series, 10);
    expect(line).toHaveLength(10);
    // Right-aligned: [0,0,0,0,0, 0,10,40,100,30] -> levels 0,0,0,4,7,2
    expect(line.slice(5)).toBe("▁▁▄█▃");
    expect(line.slice(0, 5)).toBe("▁▁▁▁▁");
  });

  test("dailySeries buckets long histories to width", () => {
    const byDay = new Map<string, UsageTotals>();
    const totals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: 0 });
    for (let d = 1; d <= 30; d += 1) byDay.set(`2026-08-${String(d).padStart(2, "0")}`, totals());
    const series = dailySeries(byDay, 10);
    expect(series).toHaveLength(10);
    expect(series.every((v) => v === 30)).toBe(true); // 3 days per bucket
  });

  test("renders a compact report with sparkline, bars, and session rows", () => {
    const summary = analyzeFile("s1.jsonl", [HEADER, ASSISTANT_WITH_SUBAGENT, SUBAGENT_RESULT_OK, ASSISTANT_PLAIN]);
    const merged = mergeReports([summary], 1);
    const text = renderReport({ cwd: "/some/project", ...merged });

    expect(text).toContain("Usage — /some/project");
    expect(text).toContain("1 session · 34k tokens total · $0.00 · 1 skipped");
    expect(text).toContain("Daily");
    expect(text).toContain("By model:");
    expect(text).toContain("█");
    expect(text).toContain("opencode/deepseek-v4-flash-fr…");
    expect(text).toContain("subagent 1 · 6k");
    expect(text).toContain("Subagents:");
    expect(text).toContain("reviewer 1 · 6k");
    expect(text).toContain("Sessions:");
  });
});
describe("usage periods", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");

  test("periodSince maps periods to epoch cutoffs", () => {
    expect(periodSince("1d", now)).toBe(now - 86_400_000);
    expect(periodSince("7d", now)).toBe(now - 7 * 86_400_000);
    expect(periodSince("30d", now)).toBe(now - 30 * 86_400_000);
    expect(periodSince("all", now)).toBeUndefined();
  });

  test("analyzeFile skips entries older than since but keeps untimestamped ones", () => {
    const oldMessage = `{"type":"message","id":"old1","parentId":"h1","timestamp":"2026-08-10T09:00:00.000Z","message":{"role":"assistant","provider":"opencode","model":"deepseek-v4-flash-free","usage":{"input":100,"output":100,"cacheRead":0,"cacheWrite":0,"totalTokens":200,"cost":{"total":0}},"stopReason":"stop","content":[{"type":"text","text":"old"}]}}`;
    const noTs = `{"type":"message","id":"nts","parentId":"h1","message":{"role":"assistant","provider":"opencode","model":"deepseek-v4-flash-free","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","content":[{"type":"text","text":"x"}]}}`;
    const lines = [HEADER, oldMessage, ASSISTANT_PLAIN, noTs, BASH_WITH_USAGE];
    const since = periodSince("7d", now)!; // cutoff 2026-08-10T12:00Z
    const summary = analyzeFile("s.jsonl", lines, since);
    // Nested toolResult usage lands in byDay, not in totals (existing
    // behavior); untimestamped entries have no day bucket.
    expect(summary.totals.totalTokens).toBe(1000 + 2); // old message dropped
    expect(summary.byDay.has("2026-08-10")).toBe(false);
    expect(summary.byDay.get("2026-08-17")?.totalTokens).toBe(1000 + 60);
  });

  test("dayKey produces the UTC day key used by analyzeFile", () => {
    expect(dayKey(now)).toBe("2026-08-17");
    expect(dayKey(now - 7 * 86_400_000)).toBe("2026-08-10");
  });
});

describe("usage limits", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const report = mergeReports([analyzeFile("s1.jsonl", [HEADER, ASSISTANT_WITH_SUBAGENT, SUBAGENT_RESULT_OK, ASSISTANT_PLAIN])]);

  test("limitRows uses defaults and computes floor percent + reset texts", () => {
    const rows = limitRows(report, parseLimitsConfig(undefined), now);
    const titles = rows.map((r) => r.title);
    expect(titles).toEqual(["Current session", "Today", "This week", "This month"]);
    const today = rows.find((r) => r.title === "Today")!;
    // Today counts day usage from byDay (includes nested toolResult usage).
    expect(today.percent).toBe(Math.floor((40000 / DEFAULT_LIMITS.dailyTokens!) * 100));
    expect(today.usedText).toBe("40k / 1.0M tokens");
    expect(today.resetText).toBe("resets at end of day");
    expect(rows.find((r) => r.title === "This month")!.resetText).toBe("resets Aug 31");
    expect(rows).toHaveLength(4); // no budget row by default
  });

  test("config overrides scale percents and adds the budget row", () => {
    const config = parseLimitsConfig({ dailyTokens: 68_000, monthlyBudgetUsd: 100 });
    const rows = limitRows(report, config, now);
    expect(rows.find((r) => r.title === "Today")!.percent).toBe(58);
    const budget = rows.find((r) => r.title === "Monthly budget")!;
    expect(budget).toBeDefined();
    expect(budget.usedText).toBe("$0.00 / $100.00");
    expect(rows).toHaveLength(5);
  });

  test("parseLimitsConfig falls back per-field on missing/invalid values", () => {
    expect(parseLimitsConfig(undefined).dailyTokens).toBe(1_000_000);
    expect(parseLimitsConfig({ dailyTokens: 500_000, weeklyTokens: "big" }).dailyTokens).toBe(500_000);
    expect(parseLimitsConfig({ dailyTokens: "big" }).dailyTokens).toBe(1_000_000);
    expect(parseLimitsConfig({ dailyTokens: 0 })).toEqual(DEFAULT_LIMITS);
    expect(parseLimitsConfig(null).monthlyTokens).toBe(15_000_000);
  });
});

describe("progress bar", () => {
  test("mirrors Claude Code BLOCKS math: full blocks, one partial, empty rest", () => {
    expect(PROGRESS_BLOCKS).toEqual([" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"]);
    expect(progressBarSegments(0.5, 10)).toEqual({ whole: 5, partial: " ", empty: 4 });
    expect(progressBarSegments(0.63, 10)).toEqual({ whole: 6, partial: "▎", empty: 3 });
    expect(progressBarSegments(1, 10)).toEqual({ whole: 10, partial: "", empty: 0 });
    expect(progressBarSegments(0, 10).whole).toBe(0);
  });

  test("clamps ratio and width", () => {
    expect(progressBarSegments(2, 4)).toEqual({ whole: 4, partial: "", empty: 0 });
    expect(progressBarSegments(-0.2, 4).whole).toBe(0);
    expect(progressBarSegments(0.3, 0)).toEqual({ whole: 0, partial: "▎", empty: 0 });
    expect(progressBarText(0.63, 10)).toBe("██████▎   ");
  });
});

describe("daily chart", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");

  test("maps period to column count", () => {
    expect(chartDayCount("1d")).toBe(7);
    expect(chartDayCount("7d")).toBe(7);
    expect(chartDayCount("30d")).toBe(30);
    expect(chartDayCount("all")).toBe(14);
  });

  test("fills missing days and ends on today", () => {
    const byDay = new Map([
      ["2026-08-17", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 40000, cost: 0 }],
      ["2026-08-15", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1000, cost: 0 }],
    ]);
    const points = dailyChartPoints(byDay, 7, now);
    expect(points).toHaveLength(7);
    expect(points[0]!.date).toBe("2026-08-11");
    expect(points[4]!.date).toBe("2026-08-15");
    expect(points[4]!.tokens).toBe(1000);
    expect(points[5]!.tokens).toBe(0);
    expect(points[6]!).toEqual({ date: "2026-08-17", tokens: 40000 });
    expect(weekdayLetter("2026-08-17")).toBe("M");
  });

  test("renders column glyphs from top to bottom", () => {
    const chart = renderDailyChartLines(
      [
        { date: "2026-08-16", tokens: 0 },
        { date: "2026-08-17", tokens: 100 },
      ],
      4,
    );
    expect(chart.lines).toHaveLength(4);
    expect(chart.lines[0]).toBe("  █");
    expect(chart.labels).toBe("S M");
    expect(chart.caption).toBe("latest 100");
  });

  test("maps period to heatmap week count", () => {
    expect(heatmapWeekCount("7d")).toBe(8);
    expect(heatmapWeekCount("30d")).toBe(8);
    expect(heatmapWeekCount("all")).toBe(52);
  });

  test("builds a Monday-start dotted heatmap", () => {
    expect(heatmapLevel(0, 100)).toBe(0);
    expect(heatmapLevel(10, 100)).toBe(1);
    expect(heatmapLevel(80, 100)).toBe(4);
    expect(cacheHitPercent({ input: 1000, output: 0, cacheRead: 9000, cacheWrite: 0, totalTokens: 10000, cost: 0 })).toBe(90);

    const byDay = new Map([
      ["2026-08-17", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 40000, cost: 0 }],
    ]);
    const weeks = activityHeatmap(byDay, 4, now);
    expect(weeks).toHaveLength(4);
    expect(weeks[0]!.start).toBe("2026-07-27");
    expect(weeks[3]!.start).toBe("2026-08-17");
    expect(weeks[3]!.levels[0]).toBe(4);
    const grid = renderHeatmapLines(weeks);
    expect(grid.rows).toHaveLength(7);
    expect(grid.rows[0]!.startsWith("Mon ")).toBe(true);
    expect(grid.rows[0]).toContain("█");
    expect(grid.legend).toContain("Less");
    expect(grid.legend).toContain(".");
  });

  test("draws an outline step chart instead of filled bars", () => {
    const plateau = renderStepChart([100, 100, 100], 4);
    expect(plateau).toHaveLength(4);
    expect(plateau[0]).toMatch(/^┌──/);
    expect(plateau.join("")).not.toContain("█");

    const step = renderStepChart([100, 100, 40], 4);
    expect(step[0]).toContain("┐");
    expect(step.join("")).toMatch(/[└│]/);

    const overlay = renderOutlineChart([[100, 40, 40], [20, 20, 80]], 4);
    expect(overlay.lines).toHaveLength(4);
    expect(overlay.lines.every((line) => line.length === 3)).toBe(true);
    expect(overlay.owner.some((row) => row.includes(0))).toBe(true);
    expect(overlay.owner.some((row) => row.includes(1))).toBe(true);
  });

  test("keeps step transitions connected at the vertical column", () => {
    expect(renderStepChart([100, 40], 4)).toEqual(["┐ ", "│ ", "└─", "  "]);
    expect(renderStepChart([40, 100], 4)).toEqual(["┌─", "│ ", "┘ ", "  "]);
  });

  test("merges box-drawing connections when model series overlap", () => {
    const overlay = renderOutlineChart([[100, 40, 100], [40, 100, 40]], 4);
    const glyphs = overlay.lines.join("");

    expect(glyphs).toMatch(/[├┤┬┴┼]/);
    expect(overlay.owner.some((row) => row.includes(0))).toBe(true);
    expect(overlay.owner.some((row) => row.includes(1))).toBe(true);
  });

  test("assigns series colors by rank, not model name", () => {
    expect(seriesColorAt(0)).toBe("accent");
    expect(seriesColorAt(1)).toBe("syntaxFunction");
    expect(seriesColorAt(2)).toBe("warning");
    expect(seriesColorAt(6)).toBe("accent");
  });

  test("formats axis dates and quota meters", () => {
    expect(formatChartDate("2026-03-08")).toBe("Mar 8");
    expect(formatChartDate("2026-04-07")).toBe("Apr 7");
    expect(meterSegments(0.5, 10)).toEqual({ filled: 5, empty: 5 });
    expect(renderMeter(0.5, 10)).toBe("█████─────");
    expect(renderMeter(0, 4)).toBe("────");
    expect(renderMeter(1, 4)).toBe("████");
    expect(xAxisDateLine(["2026-03-08", "2026-03-16", "2026-03-20", "2026-04-07"], 32)).toContain("Mar 8");
    expect(xAxisDateLine(["2026-03-08", "2026-03-16", "2026-03-20", "2026-04-07"], 32)).toContain("Apr 7");
    const unevenAxis = xAxisDateLine(
      ["2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"],
      32,
    );
    expect(unevenAxis.indexOf("Aug 13")).toBe(7);
    expect(unevenAxis.indexOf("Aug 15")).toBe(20);
    const narrowAxis = xAxisDateLine(
      ["2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18"],
      14,
    );
    expect(narrowAxis.length).toBeLessThanOrEqual(14);
    const firstLabel = narrowAxis.indexOf("Aug 12");
    const lastLabel = narrowAxis.indexOf("Aug 18");
    expect(firstLabel).toBeGreaterThanOrEqual(0);
    expect(lastLabel).toBeGreaterThan(firstLabel + "Aug 12".length);
    expect(xAxisDateLine(["2026-08-12", "2026-08-18"], 8)).toContain("Aug 18");
    expect(widenSeries([10, 20], 3)).toEqual([10, 10, 10, 20, 20, 20]);
    expect(chartColumnsPerDay(7, 200)).toBe(2);
    expect(chartColumnsPerDay(80, 40)).toBe(1);
    expect(trimLeadingZeroDays(["a", "b", "c"], [{ values: [0, 0, 5] }])).toBe(2);
    expect(trimLeadingZeroDays(["a"], [{ values: [0] }])).toBe(0);
    expect(xAxisDateLine(["2026-08-18"], 2)).toBe("");
    expect(xAxisDateLine(["2026-08-18"], 6)).toBe("Aug 18");
  });
});

describe("usage view rows", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");

  test("buildViewRows is a heatmap plus stats, not dry limit bars", () => {
    const report = mergeReports([analyzeFile("s1.jsonl", [HEADER, ASSISTANT_WITH_SUBAGENT, SUBAGENT_RESULT_OK, ASSISTANT_PLAIN])]);
    const rows = buildViewRows(report, limitRows(report, parseLimitsConfig(undefined), now), { period: "7d", nowMs: now });
    expect(rows.filter((r) => r.kind === "limit")).toEqual([]);
    expect(rows.filter((r) => r.kind === "item")).toEqual([]);
    expect(rows.some((r) => r.kind === "heatmap")).toBe(true);
    expect(rows.some((r) => r.kind === "stats")).toBe(true);
    const stats = rows.find((r) => r.kind === "stats");
    if (stats?.kind === "stats") {
      expect(stats.entries.some((entry) => entry.label === "Favorite model")).toBe(true);
      expect(stats.entries.some((entry) => entry.label === "Sessions")).toBe(true);
    }
  });

  test("buildViewRows omits the heatmap when every day is empty", () => {
    const report = mergeReports([analyzeFile("s1.jsonl", [HEADER])]);
    const rows = buildViewRows(report, [], { period: "7d", nowMs: now });
    expect(rows.some((r) => r.kind === "heatmap")).toBe(false);
  });

  test("model pane tracks per-day series and in/out cards", () => {
    const report = mergeReports([analyzeFile("s1.jsonl", [HEADER, ASSISTANT_WITH_SUBAGENT, SUBAGENT_RESULT_OK, ASSISTANT_PLAIN])]);
    const rows = buildModelViewRows(report, { period: "7d", nowMs: now });
    expect(rows.some((r) => r.kind === "stepchart")).toBe(true);
    const chart = rows.find((r) => r.kind === "stepchart");
    if (chart?.kind === "stepchart") {
      expect(chart.series.map((item) => item.color)).toEqual(chart.series.map((_, index) => index));
    }
    const card = rows.find((r) => r.kind === "modelcard");
    expect(card?.kind).toBe("modelcard");
    if (card?.kind === "modelcard") {
      expect(card.detail).toContain("In:");
      expect(card.color).toBe(0);
    }
  });

  test("overview stats count streaks and duration", () => {
    expect(formatDuration(90_000)).toBe("1m");
    expect(formatDuration(3_600_000 + 60_000)).toBe("1h 1m");
    const report = mergeReports([analyzeFile("s1.jsonl", [HEADER, ASSISTANT_WITH_SUBAGENT, SUBAGENT_RESULT_OK, ASSISTANT_PLAIN])]);
    const stats = buildOverviewStats(report);
    expect(stats.find((entry) => entry.label === "Sessions")?.value).toBe("1");
    expect(stats.find((entry) => entry.label === "Favorite model")?.value).toContain("deepseek");
  });

  test("drillRows walks a model across files, most tokens first", () => {
    const a = analyzeFile("big.jsonl", [HEADER, ASSISTANT_WITH_SUBAGENT, SUBAGENT_RESULT_OK, ASSISTANT_PLAIN]);
    const b = analyzeFile("small.jsonl", [HEADER, ASSISTANT_PLAIN]);
    const rows = drillRows([a, b], "model", "opencode/deepseek-v4-flash-free");
    expect(rows[0]).toEqual({ kind: "section", label: "Model opencode/deepseek-v4-flash-free" });
    const items = rows.filter((r) => r.kind === "item");
    expect(items).toHaveLength(2);
    expect(items[0]!.label).toBe("big.jsonl");
    expect(items[0]!.drill).toBe("session");
    expect(items[0]!.ratio).toBe(1);
  });

  test("drillRows shows a session's models and handles unknown keys", () => {
    const a = analyzeFile("s1.jsonl", [HEADER, ASSISTANT_WITH_SUBAGENT, SUBAGENT_RESULT_OK, ASSISTANT_PLAIN]);
    const rows = drillRows([a], "session", "s1.jsonl");
    expect(rows.some((r) => r.kind === "info" && r.text.includes("Session s1.jsonl"))).toBe(true);
    expect(rows.find((r) => r.kind === "section")!.label).toBe("By model");
    const notFound = drillRows([a], "session", "ghost.jsonl");
    expect(notFound[0]!.kind).toBe("info");
    expect(notFound[0]!.text.startsWith("Session not found")).toBe(true);
  });
});
