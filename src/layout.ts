export type UsageLayoutMode = "wide" | "compact" | "stacked";

export interface UsageRowLayout {
  readonly mode: UsageLayoutMode;
  readonly width: number;
  readonly leadingWidth: number;
  readonly labelWidth: number;
  readonly barWidth: number;
  readonly detailWidth: number;
  /** Space between the bar and the right-aligned detail column. */
  readonly gap: number;
  /** Space between the label and the bar. */
  readonly labelGap: number;
}

function normalizeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolve the columns used by a usage row.
 *
 * Wide and compact rows occupy the complete terminal width: labels stay in a
 * fixed column, the bar gets the flexible middle column, and details are
 * right-aligned in a fixed-width column. Very narrow terminals use separate
 * rows so the three values cannot collide.
 */
export function getUsageRowLayout(width: number, leadingWidth = 0): UsageRowLayout {
  const terminalWidth = normalizeWidth(width);
  const requestedLeading = Number.isFinite(leadingWidth) ? Math.floor(leadingWidth) : 0;
  const leading = clamp(requestedLeading, 0, Math.max(0, terminalWidth - 1));
  const available = terminalWidth - leading;

  if (terminalWidth < 60) {
    return {
      mode: "stacked",
      width: terminalWidth,
      leadingWidth: leading,
      labelWidth: available,
      barWidth: available,
      detailWidth: available,
      gap: 0,
      labelGap: 0,
    };
  }

  const mode: UsageLayoutMode = terminalWidth >= 96 ? "wide" : "compact";
  // Calculate the visible columns from the terminal width, not from the
  // optional item marker. This keeps item bars aligned with limit bars while
  // still reserving the marker space before an item label.
  const columnLabelWidth = mode === "wide"
    ? clamp(Math.floor(terminalWidth * 0.24), 18, 26)
    : clamp(Math.floor(terminalWidth * 0.28), 16, 24);
  const labelWidth = Math.max(1, columnLabelWidth - leading);
  const detailWidth = mode === "wide"
    ? clamp(Math.floor(terminalWidth * 0.28), 18, 28)
    : clamp(Math.floor(terminalWidth * 0.32), 16, 24);
  const labelGap = 1;
  const minimumBarWidth = mode === "wide" ? 16 : 8;
  const maximumBarWidth = mode === "wide" ? 60 : 40;
  const remaining = Math.max(1, available - labelWidth - labelGap - detailWidth);
  const barWidth = clamp(
    Math.floor(remaining * 0.85),
    Math.min(minimumBarWidth, remaining),
    Math.min(maximumBarWidth, remaining),
  );
  const gap = Math.max(0, available - labelWidth - labelGap - barWidth - detailWidth);

  return {
    mode,
    width: terminalWidth,
    leadingWidth: leading,
    labelWidth,
    barWidth,
    detailWidth,
    gap,
    labelGap,
  };
}

export function usageRowWidth(layout: UsageRowLayout): number {
  if (layout.mode === "stacked") return layout.width;
  return layout.leadingWidth
    + layout.labelWidth
    + layout.labelGap
    + layout.barWidth
    + layout.gap
    + layout.detailWidth;
}
