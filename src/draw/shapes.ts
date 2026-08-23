// A tiny, dependency-free canvas drawing model.
//
// Shapes are plain data. Everything here is a pure function over that data
// (plus the browser 2D canvas API for rendering / measuring). No React, no
// Tauri, no external libraries — this module is safe to unit-test or reuse.

/** The tools the editor exposes. "select" is not a shape type. */
export type Tool = "select" | "pen" | "line" | "arrow" | "rect" | "ellipse" | "text";

/**
 * One drawable thing on the canvas.
 *
 * Which optional fields are populated depends on `type`:
 *   - pen                    -> `points` (a polyline)
 *   - line / arrow           -> `x1,y1` (start) and `x2,y2` (end)
 *   - rect / ellipse         -> `x1,y1` and `x2,y2` (opposite corners)
 *   - text                   -> `x1,y1` (baseline origin) and `text`
 */
export interface Shape {
  id: number;
  type: Exclude<Tool, "select">;
  color: string;
  width: number;
  points?: { x: number; y: number }[];
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  text?: string;
}

// Text rendering constants. Kept in one place so measuring, bounds and
// rendering all agree on the same metrics.
const TEXT_SIZE = 20;
const TEXT_FONT = `${TEXT_SIZE}px system-ui, -apple-system, sans-serif`;
// Approximate ascent above the baseline for a 20px face.
const TEXT_ASCENT = 16;

// A lazily-created offscreen context used only to measure text widths so
// shapeBounds()/hitTest() can work without a live rendering context.
let measureCtx: CanvasRenderingContext2D | null = null;
function measureTextWidth(text: string): number {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return text.length * 11; // fallback estimate
  measureCtx.font = TEXT_FONT;
  return measureCtx.measureText(text).width;
}

/** Normalize two opposite corners into a top-left origin + size. */
function normRect(x1: number, y1: number, x2: number, y2: number) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

/** Perpendicular distance from a point to a line segment. */
function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Draw a simple two-segment arrowhead pointing at (x2,y2). */
function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
): void {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = 10 + width * 2;
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - len * Math.cos(angle - spread), y2 - len * Math.sin(angle - spread));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - len * Math.cos(angle + spread), y2 - len * Math.sin(angle + spread));
  ctx.stroke();
}

/** Axis-aligned bounding box for a shape, in canvas coordinates. */
export function shapeBounds(s: Shape): { x: number; y: number; w: number; h: number } {
  switch (s.type) {
    case "pen": {
      const pts = s.points ?? [];
      if (!pts.length) return { x: s.x1 ?? 0, y: s.y1 ?? 0, w: 0, h: 0 };
      let minx = pts[0].x;
      let miny = pts[0].y;
      let maxx = pts[0].x;
      let maxy = pts[0].y;
      for (const p of pts) {
        if (p.x < minx) minx = p.x;
        if (p.y < miny) miny = p.y;
        if (p.x > maxx) maxx = p.x;
        if (p.y > maxy) maxy = p.y;
      }
      return { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
    }
    case "text": {
      const w = measureTextWidth(s.text ?? "");
      return { x: s.x1 ?? 0, y: (s.y1 ?? 0) - TEXT_ASCENT, w, h: TEXT_SIZE * 1.25 };
    }
    default:
      // line / arrow / rect / ellipse all live between two points.
      return normRect(s.x1 ?? 0, s.y1 ?? 0, s.x2 ?? 0, s.y2 ?? 0);
  }
}

/** True if the point is close enough to be considered "on" the shape. */
function isHit(s: Shape, x: number, y: number): boolean {
  const tol = 8;
  switch (s.type) {
    case "pen": {
      const pts = s.points ?? [];
      if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y) <= tol;
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSegment(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= tol + s.width / 2)
          return true;
      }
      return false;
    }
    case "line":
    case "arrow":
      return (
        distToSegment(x, y, s.x1 ?? 0, s.y1 ?? 0, s.x2 ?? 0, s.y2 ?? 0) <= tol + s.width / 2
      );
    default: {
      // rect / ellipse / text: a padded bounding-box test is plenty.
      const b = shapeBounds(s);
      return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
    }
  }
}

/** Topmost shape (last drawn) under the given point, or null. */
export function hitTest(shapes: Shape[], x: number, y: number): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (isHit(shapes[i], x, y)) return shapes[i];
  }
  return null;
}

/** Move a shape in place by (dx, dy), touching whichever fields it uses. */
export function moveShape(s: Shape, dx: number, dy: number): void {
  if (s.points) {
    for (const p of s.points) {
      p.x += dx;
      p.y += dy;
    }
  }
  if (s.x1 !== undefined) s.x1 += dx;
  if (s.y1 !== undefined) s.y1 += dy;
  if (s.x2 !== undefined) s.x2 += dx;
  if (s.y2 !== undefined) s.y2 += dy;
}

/** Draw a single shape (no selection chrome). */
function drawShape(ctx: CanvasRenderingContext2D, s: Shape): void {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (s.type) {
    case "pen": {
      const pts = s.points ?? [];
      if (pts.length < 1) break;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      break;
    }
    case "line": {
      ctx.beginPath();
      ctx.moveTo(s.x1 ?? 0, s.y1 ?? 0);
      ctx.lineTo(s.x2 ?? 0, s.y2 ?? 0);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const x1 = s.x1 ?? 0;
      const y1 = s.y1 ?? 0;
      const x2 = s.x2 ?? 0;
      const y2 = s.y2 ?? 0;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      drawArrowhead(ctx, x1, y1, x2, y2, s.width);
      break;
    }
    case "rect": {
      const r = normRect(s.x1 ?? 0, s.y1 ?? 0, s.x2 ?? 0, s.y2 ?? 0);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case "ellipse": {
      const r = normRect(s.x1 ?? 0, s.y1 ?? 0, s.x2 ?? 0, s.y2 ?? 0);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "text": {
      ctx.font = TEXT_FONT;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(s.text ?? "", s.x1 ?? 0, s.y1 ?? 0);
      break;
    }
  }
}

/**
 * Render all shapes onto `ctx`. When `opts.selectedId` matches a shape, a
 * subtle dashed outline is drawn around that shape's bounds.
 */
export function renderShapes(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  opts?: { selectedId?: number | null },
): void {
  const selectedId = opts?.selectedId ?? null;

  for (const s of shapes) drawShape(ctx, s);

  if (selectedId != null) {
    const sel = shapes.find((s) => s.id === selectedId);
    if (sel) {
      const b = shapeBounds(sel);
      const pad = 4;
      // Theme-aware accent; falls back to a system blue if the var is absent.
      const accent =
        getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
        "#0a84ff";
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = accent;
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      ctx.restore();
    }
  }
}

/**
 * Render the shapes to an offscreen canvas at `scale` device-pixels per logical
 * pixel, on a solid white background, and return ONLY the base64 body of the
 * resulting PNG data URL (the "data:image/png;base64," prefix is stripped).
 */
export function exportPng(
  shapes: Shape[],
  width: number,
  height: number,
  scale: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  renderShapes(ctx, shapes); // no selection chrome in exports

  const url = canvas.toDataURL("image/png");
  const comma = url.indexOf(",");
  return comma >= 0 ? url.slice(comma + 1) : url;
}