import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  buildQuotaRows,
  drillRows,
  formatTokens,
  renderHeatmapLines,
  meterSegments,
  renderOutlineChart,
  seriesColorAt,
  TAB_LABELS,
  chartColumnsPerDay,
  widenSeries,
  xAxisDateLine,
  yAxisLabels,
  type DrillKind,
  type FileSummary,
  type Period,
  type QuotaRowData,
  type TabId,
  type UsageRow,
  type ViewData,
} from "./analyze.ts";

/**
 * Interactive `/usage` screen, modeled on Claude Code's Usage settings view.
 * Replaces the chat area (via `ctx.ui.custom`) until Esc/q closes it.
 *
 * Tabs: Usage (Claude Code /stats Overview heatmap + Models outline chart),
 * Quota (provider cards), Sessions (session cards). On Usage, `m` toggles
 * Overview/Models and `r` cycles Last 7 / Last 30 / All time.
 *
 * This file is deliberately thin: all row/bar/limit math lives in analyze.ts
 * (pure, unit-tested) and all network/credential work in providers.ts.
 * Rendering is layout only.
 */

export class UsageView implements Component {
  private data: ViewData;
  private selected = 0; // index into data.rows (walked over item rows only)
  private detail: { rows: UsageRow[] } | null = null;
  private detailSelected = 0;
  private reloading = false;
  private gen = 0; // guards against stale async period/reload results
  private version = 0;
  private cachedWidth = -1;
  private cachedVersion = -1;
  private cachedLines: string[] = [];
  private tab: TabId = "usage";
  private usagePane: "overview" | "models" = "overview";
  private quotaData: QuotaRowData | null = null;
  private quotaLoading = false;
  private quotaGen = 0; // guards stale async quota fetches

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly deps: {
      initial: ViewData;
      getFiles(): FileSummary[];
      reload(): Promise<ViewData>;
      onPeriod(period: Period): Promise<ViewData>;
      loadQuota(): Promise<QuotaRowData>;
      getSessionsTab(): { rows: UsageRow[]; count: number };
      done(): void;
    },
  ) {
    this.data = deps.initial;
    this.snapSelected();
  }

  /** Point the selection at the first selectable item row of the current tab
   * (limits/section/info/quota rows are not selectable). */
  private snapSelected(): void {
    const rows = this.detail ? this.detail.rows : this.currentRows();
    const idx = rows.findIndex((row) => row.kind === "item");
    if (this.detail) this.detailSelected = idx === -1 ? 0 : idx;
    else this.selected = idx === -1 ? 0 : idx;
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.deps.done();
      return true;
    }
    if (this.reloading) return true; // drop everything else while refreshing

    const rows = this.detail ? this.detail.rows : this.currentRows();
    const selected = this.detail ? this.detailSelected : this.selected;

    if (matchesKey(data, "up") || data === "k" || data === "K") this.move(rows, -1);
    else if (matchesKey(data, "down") || data === "j" || data === "J") this.move(rows, +1);
    else if (matchesKey(data, "left")) this.switchTab(-1);
    else if (matchesKey(data, "right") || matchesKey(data, "tab")) this.switchTab(+1);
    else if (matchesKey(data, "return") || matchesKey(data, "enter") || data === " ") {
      const row = rows[selected];
      if (row?.kind === "item") this.openDrill(row);
    } else if (matchesKey(data, "backspace")) {
      if (this.detail) {
        this.detail = null;
        this.bump();
      }
    } else if (!this.detail && this.tab === "usage") {
      if (data === "m" || data === "M") {
        this.usagePane = this.usagePane === "overview" ? "models" : "overview";
        this.bump();
      } else if (data === "1") void this.swapPeriod("1d");
      else if (data === "7") void this.swapPeriod("7d");
      else if (data === "3") void this.swapPeriod("30d");
      else if (data === "a" || data === "A") void this.swapPeriod("all");
      else if (data === "r" || data === "R") {
        const order: Period[] = ["7d", "30d", "all"];
        const idx = order.indexOf(this.data.period === "1d" ? "7d" : this.data.period);
        void this.swapPeriod(order[(idx + 1) % order.length]!);
      }
    } else if (!this.detail && (data === "r" || data === "R")) {
      if (this.tab === "quota") this.loadQuota();
      else this.reload();
    }
    return true;
  }

  /** Rows for the current tab (detail view wins while open). */
  private currentRows(): UsageRow[] {
    if (this.tab === "quota") return this.quotaData ? buildQuotaRows(this.quotaData) : [];
    if (this.tab === "sessions") return this.deps.getSessionsTab().rows;
    return this.usagePane === "models" ? this.data.modelRows : this.data.rows;
  }

  private switchTab(delta: number): void {
    const order: TabId[] = ["usage", "quota", "sessions"];
    const idx = order.indexOf(this.tab);
    const next = order[(idx + delta + order.length) % order.length]!;
    if (next === this.tab) return;
    this.tab = next;
    this.detail = null;
    this.snapSelected();
    if (next === "quota" && this.quotaData === null) this.loadQuota();
    this.bump();
  }

  private loadQuota(): void {
    const gen = ++this.quotaGen;
    this.quotaLoading = true;
    this.bump();
    void this.deps
      .loadQuota()
      .then((data) => {
        if (gen !== this.quotaGen) return;
        this.quotaData = data;
      })
      .catch(() => undefined)
      .finally(() => {
        if (gen === this.quotaGen) {
          this.quotaLoading = false;
          this.bump();
        }
      });
  }

  private move(rows: readonly UsageRow[], delta: number): void {
    const selected = this.detail ? this.detailSelected : this.selected;
    if (rows.length === 0) return;
    let idx = selected;
    for (let steps = 0; steps < rows.length; steps++) {
      idx = (idx + delta + rows.length) % rows.length;
      if (rows[idx]!.kind === "item") {
        if (this.detail) this.detailSelected = idx;
        else this.selected = idx;
        this.bump();
        return;
      }
    }
  }

  private openDrill(row: Extract<UsageRow, { kind: "item" }>): void {
    this.detail = { rows: drillRows(this.deps.getFiles(), row.drill as DrillKind, row.key) };
    this.snapSelected();
    this.bump();
  }

  private swapPeriod(period: Period): void {
    if (period === this.data.period) return;
    const gen = ++this.gen;
    this.reloading = true;
    this.bump();
    void this.deps
      .onPeriod(period)
      .then((data) => {
        if (gen !== this.gen) return;
        this.data = data;
        this.detail = null;
        this.snapSelected();
      })
      .catch(() => undefined)
      .finally(() => {
        if (gen === this.gen) {
          this.reloading = false;
          this.bump();
        }
      });
  }

  private reload(): void {
    const gen = ++this.gen;
    this.reloading = true;
    this.bump();
    void this.deps
      .reload()
      .then((data) => {
        if (gen !== this.gen) return;
        this.data = data;
      })
      .catch(() => undefined)
      .finally(() => {
        if (gen === this.gen) {
          this.reloading = false;
          this.bump();
        }
      });
  }

  private bump(): void {
    this.version++;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): string[] {
    if (width === this.cachedWidth && this.version === this.cachedVersion) return this.cachedLines;
    const lines = this.renderLines(width);
    this.cachedWidth = width;
    this.cachedVersion = this.version;
    this.cachedLines = lines;
    return lines;
  }

  private renderLines(width: number): string[] {
    const theme = this.theme;
    const fg = (color: "accent" | "dim", text: string) => theme.fg(color, text);
    const bold = (text: string) => theme.bold(text);
    const dim = (text: string) => fg("dim", text);
    const accent = (text: string) => fg("accent", text);

    const lines: string[] = [];
    lines.push(this.renderTabs(bold, dim, accent));

    if (this.tab === "usage") {
      const overview = this.usagePane === "overview" ? bold(accent("Overview")) : dim("Overview");
      const models = this.usagePane === "models" ? bold(accent("Models")) : dim("Models");
      lines.push(`${overview}  ${models}`);
    } else if (this.tab === "quota") {
      lines.push(bold("Quota"));
    } else {
      lines.push(bold("Sessions"));
    }

    const rows = this.detail ? this.detail.rows : this.currentRows();
    let prev: UsageRow | undefined;
    let skipNext = false;
    let periodPillsShown = false;
    for (let i = 0; i < rows.length; i++) {
      if (skipNext) {
        skipNext = false;
        prev = rows[i];
        continue;
      }
      const row = rows[i]!;
      if (row.kind === "section") {
        if (prev && prev.kind !== "section") lines.push("");
        lines.push(bold(row.label));
      } else if (row.kind === "limit") {
        lines.push(...this.renderLimit(row, width, bold, dim, accent));
      } else if (row.kind === "quota") {
        lines.push(...this.renderQuota(row, width, bold, dim, accent));
      } else if (row.kind === "heatmap") {
        if (prev) lines.push("");
        lines.push(...this.renderHeatmap(row, width, bold, dim, accent));
      } else if (row.kind === "stats") {
        if (prev) lines.push("");
        lines.push(...this.renderStats(row, width, bold, dim, accent));
      } else if (row.kind === "stepchart") {
        if (prev) lines.push("");
        lines.push(...this.renderStepChart(row, width, bold, dim, accent));
        if (!this.detail && this.tab === "usage" && this.usagePane === "models") {
          lines.push("");
          lines.push(this.renderPeriodPills(bold, dim, accent));
          periodPillsShown = true;
        }
      } else if (row.kind === "modelcard") {
        const next = rows[i + 1];
        if (next?.kind === "modelcard" && width >= 64) {
          lines.push(...this.renderModelCardPair(row, next, width, bold, dim, accent));
          skipNext = true;
        } else {
          lines.push(...this.renderModelCard(row, width, bold, dim, accent));
        }
      } else if (row.kind === "item") {
        lines.push(...this.renderItem(row, i === (this.detail ? this.detailSelected : this.selected), width, bold, dim, accent));
      } else {
        lines.push(dim(row.text));
      }
      prev = row;
    }
    if (!this.detail && this.tab === "usage" && !periodPillsShown) {
      lines.push("");
      lines.push(this.renderPeriodPills(bold, dim, accent));
    }
    if (rows.length === 0 && !(this.tab === "quota" && this.quotaLoading && this.quotaData === null)) {
      lines.push(dim("No usage data."));
    }

    lines.push("");
    if (this.reloading || (this.tab === "quota" && this.quotaLoading)) {
      lines.push(dim("Refreshing…"));
    } else {
      lines.push(dim(this.hintText(bold)));
    }
    lines.push(dim("─".repeat(Math.max(width, 1))));

    // Custom components must honor the width passed by pi-tui. Keep this as a
    // final guard because hints, labels, and provider data can be longer than
    // the terminal even when the normal layout fits.
    return lines.map((line) => truncateToWidth(line, Math.max(0, width), ""));
  }

  /** CC-style tab bar: `‹ Usage · Quota · Sessions ›`, active in accent. */
  private renderTabs(
    bold: (s: string) => string,
    dim: (s: string) => string,
    accent: (s: string) => string,
  ): string {
    const labels = (Object.keys(TAB_LABELS) as TabId[]).map((id) =>
      id === this.tab ? bold(accent(TAB_LABELS[id])) : dim(TAB_LABELS[id]),
    );
    return `‹ ${labels.join(dim(" · "))} ›`;
  }

  private hintText(bold: (s: string) => string): string {
    if (this.detail) return `${bold("Esc")} to cancel · ${bold("Backspace")} back`;
    if (this.tab === "usage") {
      return `${bold("Esc")} to cancel · ${bold("r")} to cycle dates · ${bold("m")} models`;
    }
    if (this.tab === "quota") {
      return `${bold("Esc")} to cancel · ${bold("r")} to refresh`;
    }
    return `${bold("Esc")} to cancel · ${bold("Enter")} details`;
  }

  private renderPeriodPills(
    bold: (s: string) => string,
    dim: (s: string) => string,
    accent: (s: string) => string,
  ): string {
    const period = this.data.period === "1d" ? "7d" : this.data.period;
    const pills: { id: Period; label: string }[] = [
      { id: "all", label: "All time" },
      { id: "7d", label: "Last 7 days" },
      { id: "30d", label: "Last 30 days" },
    ];
    return pills.map((pill) => (pill.id === period ? bold(accent(pill.label)) : dim(pill.label))).join(dim(" · "));
  }

  private renderHeatmap(
    row: Extract<UsageRow, { kind: "heatmap" }>,
    width: number,
    bold: (s: string) => string,
    dim: (s: string) => string,
    accent: (s: string) => string,
  ): string[] {
    const maxWeeks = Math.max(8, Math.min(row.weeks.length, Math.max(8, width - 5)));
    const weeks = row.weeks.slice(row.weeks.length - maxWeeks);
    const grid = renderHeatmapLines(weeks);
    return [
      dim(grid.header),
      ...grid.rows.map((line) => (line.includes("█") || line.includes("▓") ? accent(line) : dim(line))),
      dim(grid.legend),
    ];
  }

  private renderStats(
    row: Extract<UsageRow, { kind: "stats" }>,
    width: number,
    bold: (s: string) => string,
    dim: (s: string) => string,
    accent: (s: string) => string,
  ): string[] {
    const col = Math.max(28, Math.floor(width / 2));
    const lines: string[] = [];
    for (let i = 0; i < row.entries.length; i += 2) {
      const left = row.entries[i]!;
      const right = row.entries[i + 1];
      const leftText = `${dim(`${left.label}:`)} ${accent(left.value)}`;
      if (!right) {
        lines.push(leftText);
        continue;
      }
      const rightText = `${dim(`${right.label}:`)} ${accent(right.value)}`;
      const pad = Math.max(1, col - visibleWidth(leftText));
      lines.push(`${leftText}${" ".repeat(pad)}${rightText}`);
    }
    return lines;
  }

  private renderStepChart(
    row: Extract<UsageRow, { kind: "stepchart" }>,
    width: number,
    bold: (s: string) => string,
    dim: (s: string) => string,
    accent: (s: string) => string,
  ): string[] {
    const height = 8;
    const max = Math.max(1, ...row.series.flatMap((item) => item.values));
    const axis = yAxisLabels(max, height);
    const axisWidth = Math.max(...axis.map((label) => visibleWidth(label)), formatTokens(0).length, 3);
    // The prefix is `axis + space + ┤ + space`; use the exact remaining
    // columns so the chart and its axes never rely on the final truncator.
    const chartWidth = Math.max(1, Math.floor(width) - axisWidth - 3);
    const dateStart = Math.max(0, row.dates.length - chartWidth);
    const dates = row.dates.slice(dateStart);
    const columnsPerDay = chartColumnsPerDay(dates.length, chartWidth);
    const series = row.series.map((item) => {
      const values = item.values.slice(Math.max(0, item.values.length - dates.length));
      const padding = Array(Math.max(0, dates.length - values.length)).fill(0);
      return widenSeries([...padding, ...values], columnsPerDay);
    });
    const chart = renderOutlineChart(series, height);
    const plotWidth = Math.max(1, visibleWidth(chart.lines[0] ?? ""));
    const colorOf = (index: number, text: string): string => this.theme.fg(seriesColorAt(index), text);
    const paint = (line: string, owners: readonly number[]): string => {
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (ch === " ") {
          out += ch;
          continue;
        }
        out += colorOf(owners[i] ?? 0, ch);
      }
      return out;
    };
    const lines = [bold(row.title)];
    for (let i = 0; i < chart.lines.length; i++) {
      const tick = (axis[i] ?? "").padStart(axisWidth);
      lines.push(`${dim(tick)} ${dim("┤")} ${paint(chart.lines[i]!, chart.owner[i]!)}`);
    }
    const axisLine = dim("└") + dim("─".repeat(plotWidth));
    lines.push(`${dim(String(0).padStart(axisWidth))} ${axisLine}`);
    lines.push(`${" ".repeat(axisWidth + 2)}${dim(xAxisDateLine(dates, plotWidth))}`);
    const legend = row.series
      .map((item) => colorOf(item.color, `● ${item.label}`))
      .join(dim(" · "));
    lines.push(legend);
    return lines;
  }

  private renderModelCard(
    row: Extract<UsageRow, { kind: "modelcard" }>,
    _width: number,
    bold: (s: string) => string,
    dim: (s: string) => string,
    accent: (s: string) => string,
  ): string[] {
    const dot = this.theme.fg(seriesColorAt(row.color), "●");
    return [`${dot} ${bold(row.label)} ${dim(`(${row.percent})`)}`, `  ${dim(row.detail)}`];
  }

  private renderModelCardPair(
    left: Extract<UsageRow, { kind: "modelcard" }>,
    right: Extract<UsageRow, { kind: "modelcard" }>,
    width: number,
    bold: (s: string) => string,
    dim: (s: string) => string,
    accent: (s: string) => string,
  ): string[] {
    const col = Math.max(28, Math.floor(width / 2));
    const leftTitle = `${this.theme.fg(seriesColorAt(left.color), "●")} ${bold(left.label)} ${dim(`(${left.percent})`)}`;
    const rightTitle = `${this.theme.fg(seriesColorAt(right.color), "●")} ${bold(right.label)} ${dim(`(${right.percent})`)}`;
    const leftDetail = `  ${dim(left.detail)}`;
    const rightDetail = dim(right.detail);
    const padTitle = Math.max(1, col - visibleWidth(leftTitle));
    const padDetail = Math.max(1, col - visibleWidth(leftDetail));
    return [`${leftTitle}${" ".repeat(padTitle)}${rightTitle}`, `${leftDetail}${" ".repeat(padDetail)}${rightDetail}`];
  }

  private renderLimit(
    row: Extract<UsageRow, { kind: "limit" }>,
    width: number,
    bold: (s: string) => string,
    dim: (s: string) => string,
    accent: (s: string) => string,
  ): string[] {
    return this.renderQuotaBar(row.title, row.percent, `${row.usedText} · ${row.resetText}`, width, bold, dim, accent);
  }

  private renderQuota(
    row: Extract<UsageRow, { kind: "quota" }>,
    width: number,
    bold: (s: string) => string,
    dim: (s: string) => string,
    accent: (s: string) => string,
  ): string[] {
    const extra = row.usedText.includes("% used") && row.usedText.startsWith(`${row.percent}%`)
      ? row.resetText
      : `${row.usedText} · ${row.resetText}`;
    return this.renderQuotaBar(row.title, row.percent, extra, width, bold, dim, accent);
  }

  private renderQuotaBar(
    title: string,
    percent: number,
    detail: string,
    width: number,
    bold: (s: string) => string,
    dim: (s: string) => string,
    accent: (s: string) => string,
  ): string[] {
    const meterWidth = Math.min(36, Math.max(12, width - Math.max(18, visibleWidth(title) + 18)));
    const { filled, empty } = meterSegments(percent / 100, meterWidth);
    const meter = `${accent("█".repeat(filled))}${dim("─".repeat(empty))}`;
    const pct = dim(`${percent}%`);
    return [
      `${bold(title)}  ${pct}`,
      `${meter}  ${dim(detail)}`,
    ];
  }

  private renderItem(
    row: Extract<UsageRow, { kind: "item" }>,
    selected: boolean,
    _width: number,
    bold: (s: string) => string,
    dim: (s: string) => string,
    accent: (s: string) => string,
  ): string[] {
    const mark = selected ? accent("› ") : "  ";
    const title = selected ? bold(row.label) : row.label;
    return [`${mark}${title}`, `  ${dim(row.detail)}`];
  }

}