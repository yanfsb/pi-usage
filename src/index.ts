import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  analyzeFile,
  buildModelViewRows,
  buildSessionsTab,
  buildViewRows,
  encodeProjectDir,
  limitRows,
  mergeReports,
  parseLimitsConfig,
  periodSince,
  renderReport,
  type FileSummary,
  type LimitsConfig,
  type Period,
  type QuotaRowData,
  type UsageRow,
  type ViewData,
} from "./analyze.ts";
import {
  fetchCodexUsage,
  fetchGoUsage,
  fetchXaiUsage,
  findCodexCreds,
  findGoApiKey,
  findXaiCreds,
  GO_KEY_HINT,
  XAI_KEY_HINT,
} from "./providers.ts";
import { UsageView } from "./view.ts";

const MAX_SESSION_BYTES = 25 * 1024 * 1024;

/** Resolve the sessions root (~/.pi/agent/sessions or equivalent). The
 * SessionManager reports its storage dir; fall back to the current session
 * file's location and finally the conventional agent-dir path. */
function resolveSessionsRoot(ctx: ExtensionContext): string {
  try {
    const dir = ctx.sessionManager.getSessionDir();
    if (dir) return dir;
  } catch {
    // fall through to env/path fallbacks
  }
  const sessionFile = process.env.PI_SESSION_FILE;
  if (sessionFile) return join(sessionFile, "..", "..");
  return join(homedir(), ".pi", "agent", "sessions");
}

/** Read the optional `usageLimits` block from settings.json (read-only — this
 * package never writes it; see the package README). Any failure falls back to
 * DEFAULT_LIMITS. */
function readLimitsConfig(): LimitsConfig {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return parseLimitsConfig(raw?.usageLimits);
  } catch {
    return parseLimitsConfig(undefined);
  }
}

interface SessionFile {
  name: string;
  lines: string[];
}

function readSessionFiles(dir: string): { files: SessionFile[]; skipped: number } {
  const files: SessionFile[] = [];
  let skipped = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    try {
      const stat = statSync(file);
      if (stat.size > MAX_SESSION_BYTES) {
        skipped += 1;
        continue;
      }
      const content = readFileSync(file, "utf8");
      files.push({ name: file, lines: content.split("\n") });
    } catch {
      skipped += 1;
    }
  }
  return { files, skipped };
}

const analyzeAll = (files: readonly SessionFile[], since?: number): FileSummary[] =>
  files.map((file) => analyzeFile(file.name, file.lines, since));

export default function usageExtension(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Show token and cost usage from local session history: /usage",
    handler: async (_args, ctx) => {
      const root = resolveSessionsRoot(ctx);
      const encoded = encodeProjectDir(ctx.cwd);
      const projectDir = join(root, encoded);
      // SessionManager may report the project dir directly instead of the root.
      const dir = existsSync(projectDir)
        ? projectDir
        : basename(root) === encoded
          ? root
          : undefined;

      if (!dir) {
        ctx.ui.notify("No session history found for this project.", "info");
        return;
      }

      const { files, skipped } = readSessionFiles(dir);
      if (files.length === 0) {
        ctx.ui.notify(
          skipped > 0
            ? `No readable session history for this project (${skipped} unreadable).`
            : "No session history found for this project.",
          "info",
        );
        return;
      }

      if (ctx.mode !== "tui") {
        const merged = mergeReports(analyzeAll(files), skipped);
        ctx.ui.notify(renderReport({ cwd: ctx.cwd, ...merged }), "info");
        return;
      }

      // --- Interactive Claude-Code-style usage screen --------------------
      let currentFiles = files;
      let currentSkipped = skipped;
      let fullSummaries = analyzeAll(currentFiles);
      let limits = limitRows(mergeReports(fullSummaries, currentSkipped), readLimitsConfig(), Date.now());
      let period: Period = "7d";
      let sessionsTabRows: UsageRow[] = [];
      let sessionsTotal = 0;
      const rebuildSessionsTab = (): void => {
        const merged = mergeReports(fullSummaries, currentSkipped);
        sessionsTotal = merged.sessions.length;
        sessionsTabRows = buildSessionsTab(merged);
      };
      rebuildSessionsTab();

      const mkData = (): ViewData => {
        const since = periodSince(period, Date.now());
        const report =
          since === undefined
            ? mergeReports(fullSummaries, currentSkipped)
            : mergeReports(analyzeAll(currentFiles, since), currentSkipped);
        return {
          cwd: ctx.cwd,
          period,
          sessionsCount: report.sessions.length,
          skipped: report.skipped,
          totals: report.totals,
          limits,
          rows: buildViewRows(report, limits, { period, nowMs: Date.now() }),
          modelRows: buildModelViewRows(report, { period, nowMs: Date.now() }),
        };
      };

      const refresh = (): void => {
        const fresh = readSessionFiles(dir);
        currentFiles = fresh.files;
        currentSkipped = fresh.skipped;
        fullSummaries = analyzeAll(currentFiles);
        limits = limitRows(mergeReports(fullSummaries, currentSkipped), readLimitsConfig(), Date.now());
        rebuildSessionsTab();
      };

      /** Lazy quota fetch (first Quota-tab show and on `r`): reads the Codex
       * SSO tokens, the OpenCode Go key, and xAI OAuth/API credentials, then
       * queries the endpoints in parallel. Keys/tokens never leave this
       * closure as strings in logs. */
      const loadQuota = async (): Promise<QuotaRowData> => {
        const zenUsed = fullSummaries.some((file) =>
          [...file.byModel.keys()].some((key) => key.startsWith("opencode/")),
        );
        const codexCreds = findCodexCreds();
        const goKey = findGoApiKey();
        const xaiCreds = findXaiCreds();
        const [codex, go, xai] = await Promise.all([
          codexCreds
            ? fetchCodexUsage(codexCreds)
            : Promise.resolve({
                source: "unavailable" as const,
                error: "No Codex auth found — run `codex login` (creates ~/.codex/auth.json)",
              }),
          goKey
            ? fetchGoUsage(goKey)
            : Promise.resolve({ source: "unavailable" as const, error: GO_KEY_HINT }),
          xaiCreds
            ? fetchXaiUsage(xaiCreds)
            : Promise.resolve({ source: "unavailable" as const, error: XAI_KEY_HINT }),
        ]);
        return { codex, go, xai, zenUsed, nowMs: Date.now() };
      };

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        return new UsageView(tui, theme, {
          initial: mkData(),
          getFiles: () => fullSummaries,
          reload: async () => {
            refresh();
            return mkData();
          },
          onPeriod: async (next: Period) => {
            period = next;
            return mkData();
          },
          loadQuota,
          getSessionsTab: (): { rows: UsageRow[]; count: number } => ({
            rows: sessionsTabRows,
            count: sessionsTotal,
          }),
          done,
        });
      });
    },
  });
}