import { describe, expect, test } from "bun:test";
import { getUsageRowLayout, usageRowWidth } from "../src/layout.ts";

describe("usage row layout", () => {
  test("fills wide and compact rows with stable columns", () => {
    for (const width of [120, 80, 60]) {
      const layout = getUsageRowLayout(width);
      expect(layout.mode).not.toBe("stacked");
      expect(usageRowWidth(layout)).toBe(width);
      expect(layout.barWidth).toBeGreaterThan(0);
      expect(layout.gap).toBeGreaterThanOrEqual(0);
      expect(layout.labelWidth + layout.labelGap).toBeLessThan(width);
    }
  });

  test("right detail and bar columns have deterministic positions", () => {
    const layout = getUsageRowLayout(120);
    const barStart = layout.leadingWidth + layout.labelWidth + layout.labelGap;
    const detailStart = barStart + layout.barWidth + layout.gap;

    expect(barStart).toBe(27);
    expect(detailStart).toBe(92);
    expect(detailStart + layout.detailWidth).toBe(120);

    const item = getUsageRowLayout(120, 2);
    expect(item.leadingWidth + item.labelWidth + item.labelGap).toBe(barStart);
    expect(item.leadingWidth + item.labelWidth + item.labelGap + item.barWidth + item.gap).toBe(detailStart);
    expect(detailStart + item.detailWidth).toBe(120);
  });

  test("selection prefix does not move the item bar column", () => {
    const selected = getUsageRowLayout(80, 2);
    const unselected = getUsageRowLayout(80, 2);

    const limit = getUsageRowLayout(80);
    expect(selected.labelWidth).toBe(unselected.labelWidth);
    expect(selected.barWidth).toBe(unselected.barWidth);
    expect(selected.leadingWidth + selected.labelWidth + selected.labelGap).toBe(
      unselected.leadingWidth + unselected.labelWidth + unselected.labelGap,
    );
    expect(selected.leadingWidth + selected.labelWidth + selected.labelGap).toBe(
      limit.leadingWidth + limit.labelWidth + limit.labelGap,
    );
    expect(usageRowWidth(selected)).toBe(80);
  });

  test("stacks columns safely on narrow terminals", () => {
    for (const width of [40, 20, 1]) {
      const layout = getUsageRowLayout(width, 2);
      expect(layout.mode).toBe("stacked");
      expect(layout.labelWidth).toBe(width - layout.leadingWidth);
      expect(layout.barWidth).toBe(width - layout.leadingWidth);
      expect(layout.detailWidth).toBe(width - layout.leadingWidth);
      expect(usageRowWidth(layout)).toBe(width);
    }
  });

  test("normalizes invalid dimensions without collisions", () => {
    const layout = getUsageRowLayout(Number.NaN, Number.NaN);
    expect(layout.width).toBe(1);
    expect(layout.leadingWidth).toBe(0);
    expect(layout.labelWidth).toBe(1);
    expect(usageRowWidth(layout)).toBe(1);
  });
});
