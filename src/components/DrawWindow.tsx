import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, applyTheme } from "../store";
import {
  exportPng,
  hitTest,
  moveShape,
  renderShapes,
  shapeBounds,
  type Shape,
  type Tool,
} from "../draw/shapes";

// A ring about the eraser's reach, so you can see what it will pick up.
const ERASER_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E" +
  "%3Ccircle cx='10' cy='10' r='9' fill='white' stroke='%23333'/%3E%3C/svg%3E\") 10 10, crosshair";

const ICON = {
  viewBox: "0 0 16 16",
  width: 16,
  height: 16,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
// Four-way arrows: pick an item up and move it.
const MOVE_ICON = (
  <svg {...ICON}>
    <path d="M8 1.8v12.4M1.8 8h12.4M6.2 3.6 8 1.8l1.8 1.8M6.2 12.4 8 14.2l1.8-1.8M3.6 6.2 1.8 8l1.8 1.8M12.4 6.2 14.2 8l-1.8 1.8" />
  </svg>
);
// A tilted block eraser.
const ERASER_ICON = (
  <svg {...ICON}>
    <path d="M10.2 2.6 13.4 5.8 7.2 12H4.6L2.6 10z" />
    <path d="M6.2 6.6 9.4 9.8M7.2 12h6" />
  </svg>
);

export default function DrawWindow() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  // The canvas model lives in a ref (mutated imperatively) since the drawing
  // surface is painted by hand — React state is used only for toolbar/UI.
  const shapesRef = useRef<Shape[]>([]);
  const draftRef = useRef<Shape | null>(null); // shape being drawn right now
  const dragRef = useRef<{ shape: Shape; lastX: number; lastY: number; moved: boolean } | null>(
    null,
  );
  // An eraser swipe in progress: the last pointer position, and whether it has
  // removed anything yet (the whole swipe is one undo step).
  const eraseRef = useRef<{ x: number; y: number; erased: boolean } | null>(null);
  // Snapshots of the canvas before each change, newest last, for undo.
  const historyRef = useRef<Shape[][]>([]);
  // Shapes are plain data, so a JSON round-trip is a full copy (and works on older
  // WebKitGTK, which lacks structuredClone).
  const remember = () => historyRef.current.push(JSON.parse(JSON.stringify(shapesRef.current)));
  const idRef = useRef(1);
  const nextId = () => idRef.current++;

  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("#1d1d1f");
  const [strokeWidth] = useState(3);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Text-entry overlay state.
  const [editing, setEditing] = useState<{ x: number; y: number } | null>(null);
  const [textValue, setTextValue] = useState("");
  const textHandledRef = useRef(false); // guards against double commit-on-blur

  // Repaint the canvas from the current model. Backing store is sized to the
  // device pixel ratio so lines stay crisp on HiDPI displays.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const list = draftRef.current
      ? shapesRef.current.concat(draftRef.current)
      : shapesRef.current;
    renderShapes(ctx, list, { selectedId });
  }, [selectedId]);

  // Apply the saved theme on mount.
  useEffect(() => {
    api.getState().then((s) => applyTheme(s.theme));
  }, []);

  // Focus the text overlay whenever it opens (autoFocus alone can miss).
  useEffect(() => {
    if (editing) requestAnimationFrame(() => textInputRef.current?.focus());
  }, [editing]);

  // Redraw whenever selection changes (and once on mount).
  useEffect(() => {
    redraw();
  }, [redraw]);

  // Keep the canvas painted as the window resizes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [redraw]);

  // Keyboard: undo, delete selection, and Escape-to-close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing !== null) return; // the text input owns the keyboard
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        const prev = historyRef.current.pop();
        if (prev) {
          shapesRef.current = prev;
          setSelectedId(null);
          redraw();
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId != null) {
          e.preventDefault();
          remember();
          shapesRef.current = shapesRef.current.filter((s) => s.id !== selectedId);
          setSelectedId(null);
          redraw();
        }
      } else if (e.key === "Escape") {
        getCurrentWindow().close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, selectedId, redraw]);

  const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getPos(e);

    if (tool === "text") {
      // Don't capture the pointer for text — it would steal focus from the
      // text input overlay. Commit any in-progress text first.
      e.preventDefault();
      if (editing) commitText();
      textHandledRef.current = false;
      setTextValue("");
      setEditing({ x, y });
      return;
    }

    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);

    if (tool === "select") {
      const hit = hitTest(shapesRef.current, x, y);
      setSelectedId(hit ? hit.id : null);
      dragRef.current = hit ? { shape: hit, lastX: x, lastY: y, moved: false } : null;
      return;
    }

    if (tool === "eraser") {
      eraseRef.current = { x, y, erased: false };
      eraseAlong(x, y, x, y);
      return;
    }

    // Freehand / geometric tools: start a draft shape.
    if (tool === "pen") {
      draftRef.current = {
        id: nextId(),
        type: "pen",
        color,
        width: strokeWidth,
        points: [{ x, y }],
      };
    } else {
      draftRef.current = {
        id: nextId(),
        type: tool,
        color,
        width: strokeWidth,
        x1: x,
        y1: y,
        x2: x,
        y2: y,
      };
    }
    redraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getPos(e);

    if (eraseRef.current) {
      const er = eraseRef.current;
      eraseAlong(er.x, er.y, x, y);
      er.x = x;
      er.y = y;
      return;
    }

    if (dragRef.current) {
      const d = dragRef.current;
      if (!d.moved) {
        remember();
        d.moved = true;
      }
      moveShape(d.shape, x - d.lastX, y - d.lastY);
      d.lastX = x;
      d.lastY = y;
      redraw();
      return;
    }

    const draft = draftRef.current;
    if (!draft) return;
    if (draft.type === "pen") {
      draft.points!.push({ x, y });
    } else {
      draft.x2 = x;
      draft.y2 = y;
    }
    redraw();
  };

  const onPointerUp = () => {
    eraseRef.current = null;
    if (dragRef.current) {
      dragRef.current = null;
      return;
    }
    const draft = draftRef.current;
    draftRef.current = null;
    if (!draft) return;

    // Drop accidental clicks that produced no real geometry.
    let keep = false;
    if (draft.type === "pen") {
      keep = (draft.points?.length ?? 0) > 1;
    } else {
      const b = shapeBounds(draft);
      keep = b.w > 2 || b.h > 2;
    }
    if (keep) {
      remember();
      shapesRef.current.push(draft);
    }
    redraw();
  };

  // Eraser: remove every shape the pointer passes over, sampling the path so a
  // quick swipe can't skip over a thin line.
  const eraseAlong = (x0: number, y0: number, x1: number, y1: number) => {
    const er = eraseRef.current;
    if (!er) return;
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4));
    let changed = false;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * i) / steps;
      let hit = hitTest(shapesRef.current, x, y);
      while (hit) {
        if (!er.erased) {
          remember();
          er.erased = true;
        }
        const gone = hit;
        shapesRef.current = shapesRef.current.filter((s) => s !== gone);
        if (gone.id === selectedId) setSelectedId(null);
        changed = true;
        hit = hitTest(shapesRef.current, x, y);
      }
    }
    if (changed) redraw();
  };

  const commitText = () => {
    if (textHandledRef.current) return;
    textHandledRef.current = true;
    const v = textValue.trim();
    if (v && editing) {
      remember();
      shapesRef.current.push({
        id: nextId(),
        type: "text",
        color,
        width: strokeWidth,
        text: v,
        x1: editing.x,
        y1: editing.y + 16, // baseline sits below the input's top edge
      });
    }
    setEditing(null);
    setTextValue("");
    redraw();
  };

  const cancelText = () => {
    textHandledRef.current = true;
    setEditing(null);
    setTextValue("");
    redraw();
  };

  const clear = () => {
    if (shapesRef.current.length) remember();
    shapesRef.current = [];
    setSelectedId(null);
    redraw();
  };

  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const b64 = exportPng(shapesRef.current, rect.width, rect.height, 2);
    await api.addImage(b64, "png");
    getCurrentWindow().close();
  };

  const tools: { t: Tool; label: React.ReactNode; title: string }[] = [
    { t: "select", label: MOVE_ICON, title: "Move (drag an item; Delete removes it)" },
    { t: "pen", label: "✏", title: "Pen" },
    { t: "eraser", label: ERASER_ICON, title: "Eraser (drag over items to remove them)" },
    { t: "line", label: "／", title: "Line" },
    { t: "arrow", label: "↗", title: "Arrow" },
    { t: "rect", label: "▭", title: "Rectangle" },
    { t: "ellipse", label: "◯", title: "Ellipse" },
    { t: "text", label: "A", title: "Text" },
  ];

  return (
    <div className="draw-window">
      <button className="draw-save" onClick={save}>
        Save
      </button>

      <canvas
        ref={canvasRef}
        className="draw-canvas"
        style={{ cursor: tool === "eraser" ? ERASER_CURSOR : tool === "select" ? "move" : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />

      {editing && (
        <input
          ref={textInputRef}
          autoFocus
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitText();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelText();
            }
          }}
          onBlur={() => {
            // Commit only if something was typed; an empty blur (e.g. the
            // opening click's mouse-up stealing focus) keeps the field open.
            if (textValue.trim()) commitText();
            else requestAnimationFrame(() => textInputRef.current?.focus());
          }}
          placeholder="Type, Enter to place"
          style={{
            position: "absolute",
            left: editing.x,
            top: editing.y,
            zIndex: 50,
            minWidth: 160,
            color,
            font: "20px system-ui, -apple-system, sans-serif",
            background: "#ffffff",
            border: "1px solid var(--accent, #2f6fed)",
            borderRadius: 4,
            outline: "none",
            padding: "2px 4px",
          }}
        />
      )}

      <div className="draw-toolbar">
        {tools.map((x) => (
          <button
            key={x.t}
            className={"draw-tool" + (tool === x.t ? " active" : "")}
            title={x.title}
            onClick={() => {
              setTool(x.t);
              setSelectedId(null);
            }}
          >
            {x.label}
          </button>
        ))}
        <input
          type="color"
          className="draw-color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        />
        <button className="draw-tool" onClick={clear}>
          Clear
        </button>
      </div>
    </div>
  );
}