import { describe, expect, test } from "bun:test";
import {
  analyzeFile,
  buildQuotaRows,
  buildSessionsTab,
  decodeChatgptIdToken,
  formatResetsAt,
  GO_PLAN_LIMITS,
  mergeReports,
  parseCodexUsageJson,
  parseGoUsageJson,
  parseXaiApiKeyJson,
  parseXaiBillingJson,
  TAB_LABELS,
} from "../src/analyze.ts";
import type { CodexQuota, GoQuota, QuotaRowData, UsageRow, XaiQuota } from "../src/analyze.ts";

const b64url = (s: string): string => Buffer.from(s).toString("base64url");
const jwt = (payload: Record<string, unknown>): string => `${b64url("{}")}.${b64url(JSON.stringify(payload))}.${b64url("sig")}`;

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

describe("tabs", () => {
  test("TAB_LABELS covers the approved tab set", () => {
    expect(TAB_LABELS).toEqual({ usage: "Usage", quota: "Quota", sessions: "Sessions" });
  });

  test("formatResetsAt renders minute/hour/day windows", () => {
    expect(formatResetsAt(NOW + 30 * 60_000, NOW)).toBe("resets in 30m");
    expect(formatResetsAt(NOW + 5 * 3_600_000 + 53 * 60_000, NOW)).toBe("resets in 5h 53m");
    expect(formatResetsAt(NOW + 2 * 86_400_000 + 5 * 3_600_000, NOW)).toBe("resets in 2d 5h");
    expect(formatResetsAt(NOW - 1_000, NOW)).toBe("resets now");
    expect(formatResetsAt(Number.NaN, NOW)).toBe("resets now");
  });
});

describe("codex quota parsing", () => {
  test("parses rate_limit windows, credits, plan, and reached type", () => {
    const quota = parseCodexUsageJson({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1711900000 },
        secondary_window: { used_percent: 15, limit_window_seconds: 604800, reset_at: 1712400000 },
      },
      credits: { has_credits: true, unlimited: false, balance: "$5.00" },
      rate_limit_reached_type: null,
    });
    expect(quota).not.toBeNull();
    expect(quota!.planType).toBe("pro");
    expect(quota!.windows).toHaveLength(2);
    expect(quota!.windows[0]).toEqual({ label: "5h", usedPercent: 42, resetsAtMs: 1711900000000 });
    expect(quota!.windows[1]!.label).toBe("weekly");
    expect(quota!.credits).toEqual({ hasCredits: true, unlimited: false, balance: "$5.00" });
    expect(quota!.rateLimitReached).toBeUndefined();
  });

  test("tolerates alias shapes (top-level five_hour/weekly) and reset_time_ms", () => {
    const quota = parseCodexUsageJson({
      five_hour: { used_percent: 10, limit_window_seconds: 18000, reset_time_ms: 1711900000000 },
      weekly: { used_percent: 90, limit_window_seconds: 604800, reset_at: 1712400000 },
    });
    expect(quota!.windows).toHaveLength(2);
    expect(quota!.windows[0]!.resetsAtMs).toBe(1711900000000);
    expect(quota!.windows[1]!.usedPercent).toBe(90);
  });

  test("skips windows with missing/NaN percents and a reached string", () => {
    const quota = parseCodexUsageJson({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: Number.NaN, reset_at: 1 } },
      rate_limit_reached_type: "primary",
    });
    expect(quota!.windows).toHaveLength(0);
    expect(quota!.planType).toBe("plus");
    expect(quota!.rateLimitReached).toBe("primary");
  });

  test("returns null for unusable bodies", () => {
    expect(parseCodexUsageJson(null)).toBeNull();
    expect(parseCodexUsageJson({})).toBeNull();
    expect(parseCodexUsageJson({ usage: { x: 1 } })).toBeNull();
  });
});

describe("chatgpt id token", () => {
  test("decodes plan, email, and account claims from the JWT payload", () => {
    const claims = decodeChatgptIdToken(
      jwt({
        email: "you@example.com",
        "https://api.openai.com/auth": {
          chatgpt_plan_type: "pro",
          chatgpt_user_id: "user-1",
          chatgpt_account_id: "acct-1",
        },
      }),
    );
    expect(claims).toEqual({ email: "you@example.com", planType: "Pro", accountId: "acct-1" });
  });

  test("falls back to profile email and unknown plan names pass through", () => {
    const claims = decodeChatgptIdToken(
      jwt({ "https://api.openai.com/profile": { email: "p@x.com" }, "https://api.openai.com/auth": { chatgpt_plan_type: "mega" } }),
    );
    expect(claims.email).toBe("p@x.com");
    expect(claims.planType).toBe("mega");
  });

  test("handles garbage tokens", () => {
    expect(decodeChatgptIdToken("")).toEqual({});
    expect(decodeChatgptIdToken("not.a.jwt")).toEqual({});
    expect(decodeChatgptIdToken("a.!!!.c")).toEqual({});
    expect(decodeChatgptIdToken(jwt({}))).toEqual({});
  });
});

describe("opencode go quota parsing", () => {
  test("parses all three windows", () => {
    const quota = parseGoUsageJson({
      usage: {
        rolling: { status: "ok", percent: 12, resetsAt: "2026-08-17T17:00:00.000Z" },
        weekly: { status: "ok", percent: 45, resetsAt: "2026-08-23T00:00:00.000Z" },
        monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-09-01T00:00:00.000Z" },
      },
    });
    expect(quota).not.toBeNull();
    expect(quota!.windows).toHaveLength(3);
    expect(quota!.windows[0]).toEqual({ kind: "rolling", status: "ok", percent: 12, resetsAt: "2026-08-17T17:00:00.000Z" });
    expect(quota!.windows[2]!.status).toBe("rate-limited");
  });

  test("skips malformed windows and rejects unusable bodies", () => {
    const quota = parseGoUsageJson({ usage: { rolling: { status: "weird", percent: 1, resetsAt: "x" }, weekly: { percent: 5 } } });
    expect(quota).toBeNull();
    expect(parseGoUsageJson({})).toBeNull();
    expect(parseGoUsageJson({ usage: null })).toBeNull();
  });

  test("GO_PLAN_LIMITS mirrors the Go plan schema", () => {
    expect(GO_PLAN_LIMITS.rolling.usd).toBe(12);
    expect(GO_PLAN_LIMITS.weekly.usd).toBe(30);
    expect(GO_PLAN_LIMITS.monthly.usd).toBe(60);
    expect(GO_PLAN_LIMITS.rolling.label).toBe("$12");
  });
});

describe("xAI quota parsing", () => {
  test("parses subscription weekly credits and prepaid notes", () => {
    const quota = parseXaiBillingJson({
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-08-17T00:00:00.000Z",
          end: "2026-08-24T00:00:00.000Z",
        },
        prepaidBalance: { val: 1250 },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
      },
    });
    expect(quota).not.toBeNull();
    expect(quota!.source).toBe("live");
    expect(quota!.mode).toBe("subscription");
    expect(quota!.windows).toHaveLength(1);
    expect(quota!.windows[0]).toMatchObject({
      title: "Weekly",
      percent: 42.5,
      usedText: "42% used",
      resetsAtMs: Date.parse("2026-08-24T00:00:00.000Z"),
    });
    expect(quota!.notes).toEqual(["Prepaid: $12.50 remaining"]);
  });

  test("parses legacy monthly allowance in cents and on-demand cap", () => {
    const quota = parseXaiBillingJson({
      config: {
        monthlyLimit: { val: 15000 },
        used: { val: 2931 },
        billingPeriodEnd: "2026-09-01T00:00:00.000Z",
        onDemandCap: { val: 5000 },
        onDemandUsed: { val: 300 },
      },
    });
    expect(quota!.windows).toEqual([
      {
        title: "Monthly allowance",
        percent: (29.31 / 150) * 100,
        usedText: "$29.31 / $150.00",
        resetsAtMs: Date.parse("2026-09-01T00:00:00.000Z"),
      },
      {
        title: "On-demand",
        percent: (3 / 50) * 100,
        usedText: "$3.00 / $50.00",
      },
    ]);
  });

  test("defaults missing creditUsagePercent to 0 when a period is present", () => {
    const quota = parseXaiBillingJson({
      config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-08-24T00:00:00.000Z" } },
    });
    expect(quota!.windows[0]).toMatchObject({ title: "Weekly", percent: 0, usedText: "0% used" });
  });

  test("rejects unusable billing bodies", () => {
    expect(parseXaiBillingJson(null)).toBeNull();
    expect(parseXaiBillingJson({})).toBeNull();
    expect(parseXaiBillingJson({ config: { onDemandCap: { val: 0 } } })).toBeNull();
  });

  test("parses API key credit balances in USD", () => {
    const quota = parseXaiApiKeyJson({
      name: "pi",
      remaining_balance: "12.5",
      spent_balance: 87.5,
      total_granted: 100,
    });
    expect(quota).toMatchObject({
      source: "live",
      mode: "api",
      label: "pi",
      windows: [{ title: "Credits", percent: 87.5, usedText: "$12.50 remaining · of $100.00" }],
    });
  });

  test("notes an active key with no credit fields", () => {
    const quota = parseXaiApiKeyJson({ name: "pi", api_key_id: "id-1", acls: ["api-key:model:*"] });
    expect(quota!.windows).toEqual([]);
    expect(quota!.notes).toEqual(["API key active — no credit balance reported"]);
  });

  test("flags a blocked key", () => {
    const quota = parseXaiApiKeyJson({ name: "pi", api_key_id: "id-1", api_key_blocked: true, remaining_balance: 0 });
    expect(quota!.notes).toContain("API key or team is blocked");
  });

  test("returns null for unusable api-key bodies", () => {
    expect(parseXaiApiKeyJson(null)).toBeNull();
    expect(parseXaiApiKeyJson({})).toBeNull();
  });
});

describe("quota rows", () => {
  const codexLive: CodexQuota = {
    planType: "Pro",
    email: "you@example.com",
    source: "live",
    windows: [
      { label: "5h", usedPercent: 42, resetsAtMs: NOW + 5 * 3_600_000 + 53 * 60_000 },
      { label: "weekly", usedPercent: 15, resetsAtMs: NOW + 2 * 86_400_000 },
    ],
    credits: { hasCredits: true, unlimited: false, balance: "$5.00" },
  };
  const codexUnavailable: CodexQuota = { source: "unavailable", windows: [], error: "Codex token expired — run `codex login`" };
  const goLive: GoQuota = {
    source: "live",
    windows: [
      { kind: "rolling", status: "ok", percent: 12, resetsAt: new Date(NOW + 60 * 60_000).toISOString() },
      { kind: "weekly", status: "ok", percent: 45, resetsAt: new Date(NOW + 2 * 86_400_000).toISOString() },
    ],
  };
  const goRateLimited: GoQuota = {
    source: "live",
    windows: [{ kind: "monthly", status: "rate-limited", percent: 100, resetsAt: new Date(NOW + 86_400_000).toISOString() }],
  };
  const goUnavailable: GoQuota = { source: "unavailable", windows: [], error: "No OpenCode Go API key" };
  const xaiUnavailable: XaiQuota = { source: "unavailable", error: "No xAI auth" };
  const xaiLive: XaiQuota = {
    source: "live",
    mode: "subscription",
    windows: [
      {
        title: "Weekly",
        percent: 75,
        usedText: "75% used",
        resetsAtMs: NOW + 2 * 86_400_000,
      },
    ],
    notes: ["Prepaid: $12.50 remaining"],
  };

  const quotaRows = (codex: CodexQuota, go: GoQuota, zenUsed = false, xai: XaiQuota = xaiUnavailable): UsageRow[] =>
    buildQuotaRows({ codex, go, xai, zenUsed, nowMs: NOW } satisfies QuotaRowData);

  test("renders live Codex + Go windows with plan identity and credits", () => {
    const rows = quotaRows(codexLive, goLive);
    expect(rows.filter((r) => r.kind === "section").map((r) => r.label)).toEqual([
      "Codex (ChatGPT subscription)",
      "OpenCode Go",
      "xAI (Grok)",
    ]);
    const quota = rows.filter((r) => r.kind === "quota");
    expect(quota).toHaveLength(4);
    expect(quota[0]).toMatchObject({ kind: "quota", title: "5h quota", percent: 42, usedText: "42% used" });
    expect((quota[0]! as Extract<UsageRow, { kind: "quota" }>).resetText).toBe("resets in 5h 53m");
    const goRolling = quota[2] as Extract<UsageRow, { kind: "quota" }>;
    expect(goRolling.title).toBe("5h rolling");
    expect(goRolling.usedText).toBe("12% used · of $12");
    expect(rows.some((r) => r.kind === "info" && r.text.includes("you@example.com"))).toBe(false);
    expect(rows.some((r) => r.kind === "info" && r.text === "Extra usage: $5.00")).toBe(true);
  });

  test("flags rate-limited windows and hides the rate-limit info for ok windows", () => {
    const rows = quotaRows(codexLive, goRateLimited);
    const info = rows.filter((r) => r.kind === "info").map((r) => r.text);
    expect(info.some((t) => t.includes("Rate limited — monthly window exhausted"))).toBe(true);
  });

  test("shows graceful hints when credentials/endpoints are unavailable", () => {
    const rows = quotaRows(codexUnavailable, goUnavailable);
    const info = rows.filter((r) => r.kind === "info").map((r) => r.text);
    expect(info).toContain("Codex token expired — run `codex login`");
    expect(info).toContain("No OpenCode Go API key");
    expect(info).toContain("No xAI auth");
  });

  test("renders live xAI subscription windows and prepaid notes", () => {
    const rows = quotaRows(codexLive, goLive, false, xaiLive);
    const quota = rows.filter((r) => r.kind === "quota");
    expect(quota).toHaveLength(5);
    expect(quota[4]).toMatchObject({ kind: "quota", title: "Weekly", percent: 75, usedText: "75% used" });
    expect((quota[4]! as Extract<UsageRow, { kind: "quota" }>).resetText).toBe("resets in 2d 0h");
    expect(rows.some((r) => r.kind === "info" && r.text === "subscription")).toBe(false);
    expect(rows.some((r) => r.kind === "info" && r.text === "Prepaid: $12.50 remaining")).toBe(true);
  });

  test("adds the Zen free tier note when opencode models are in use", () => {
    const rows = quotaRows(codexLive, goLive, true);
    expect(rows.some((r) => r.kind === "section" && r.label === "Zen free tier")).toBe(true);
    expect(rows.some((r) => r.kind === "info" && r.text.includes("no quota"))).toBe(true);
  });
});

describe("sessions tab", () => {
  const HEADER = `{"type":"session","version":3,"id":"uuid1","timestamp":"2026-08-17T03:30:27.800Z","cwd":"/p"}`;
  const msg = (ts: string, tokens: number) =>
    `{"type":"message","id":"m","parentId":"h","timestamp":"${ts}","message":{"role":"assistant","provider":"p","model":"m","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":${tokens},"cost":{"total":0}},"stopReason":"stop","content":[{"type":"text","text":"x"}]}}`;

  test("lists sessions most recent first with date, tokens, duration, and model", () => {
    const report = mergeReports([
      analyzeFile("old.jsonl", [HEADER, msg("2026-08-01T00:00:00.000Z", 1000)]),
      analyzeFile("new.jsonl", [HEADER, msg("2026-08-17T00:00:00.000Z", 4000)]),
    ]);
    const rows = buildSessionsTab(report);
    expect(rows.some((r) => r.kind === "stats")).toBe(true);
    const items = rows.filter((r) => r.kind === "item");
    expect(items).toHaveLength(2);
    expect(items[0]!.label).toBe("new.jsonl");
    expect(items[0]!.ratio).toBe(1);
    expect(items[1]!.ratio).toBe(0.25);
    const detail = (items[0]! as Extract<UsageRow, { kind: "item" }>).detail;
    expect(detail).toContain("2026-08-17");
    expect(detail).toContain("4k");
    expect(detail).toContain("m");
  });

  test("caps long histories at 20 rows with a +N more info line", () => {
    const summaries = [];
    for (let i = 0; i < 25; i += 1) {
      summaries.push(analyzeFile(`s${i}.jsonl`, [HEADER, msg(`2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, 10)]));
    }
    const rows = buildSessionsTab(mergeReports(summaries));
    expect(rows.filter((r) => r.kind === "item")).toHaveLength(20);
    expect(rows.some((r) => r.kind === "info" && r.text === "+5 more sessions")).toBe(true);
  });

  test("handles an empty report", () => {
    const rows = buildSessionsTab(mergeReports([]));
    expect(rows[0]).toEqual({ kind: "info", text: "No sessions." });
  });
});
