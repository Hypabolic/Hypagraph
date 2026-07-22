import type { NodeStatus } from "../domain/model.js";
import type { GraphLayout, GraphLayoutEdge, GraphLayoutNode, GraphPoint } from "./layout.js";
import type { GraphViewModel } from "./projection.js";

export interface GraphRenderOptions {
  width: number;
  height: number;
  viewportX?: number;
  viewportY?: number;
  selectedNodeId?: string;
  unicode?: boolean;
}

const STATUS_MARKERS: Record<NodeStatus, string> = {
  pending: "○",
  ready: "◇",
  starting: "▶",
  running: "▶",
  awaiting_evidence: "?",
  verifying: "V",
  succeeded: "✓",
  failed: "✗",
  blocked: "■",
  cancelled: "×",
  skipped: "–",
  stale: "!",
};

const ASCII_STATUS_MARKERS: Record<NodeStatus, string> = {
  pending: "o",
  ready: "?",
  starting: ">",
  running: ">",
  awaiting_evidence: "?",
  verifying: "V",
  succeeded: "+",
  failed: "x",
  blocked: "#",
  cancelled: "x",
  skipped: "-",
  stale: "!",
};

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const truncate = (value: string, width: number): string => {
  const clean = sanitizeTerminalText(value);
  if (width <= 0) return "";
  if (clean.length <= width) return clean.padEnd(width, " ");
  if (width === 1) return clean.slice(0, 1);
  return `${clean.slice(0, width - 1)}…`;
};

class CharacterCanvas {
  private readonly cells: string[][];

  constructor(readonly width: number, readonly height: number) {
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  }

  set(x: number, y: number, value: string): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.cells[y]![x] = value;
  }

  get(x: number, y: number): string {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return " ";
    return this.cells[y]![x]!;
  }

  text(x: number, y: number, value: string, maxWidth = value.length): void {
    const safe = sanitizeTerminalText(value).slice(0, Math.max(0, maxWidth));
    for (let index = 0; index < safe.length; index += 1) this.set(x + index, y, safe[index]!);
  }

  lines(viewportX: number, viewportY: number, width: number, height: number): string[] {
    const result: string[] = [];
    for (let row = 0; row < height; row += 1) {
      const source = this.cells[viewportY + row] ?? [];
      const line = source.slice(viewportX, viewportX + width).join("").padEnd(width, " ");
      result.push(line.slice(0, width));
    }
    return result;
  }
}

const drawRect = (
  canvas: CharacterCanvas,
  x: number,
  y: number,
  width: number,
  height: number,
  selected: boolean,
  unicode: boolean,
): void => {
  const glyphs = unicode
    ? selected
      ? { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" }
      : { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: selected ? "=" : "-", v: "|" };
  canvas.set(x, y, glyphs.tl);
  canvas.set(x + width - 1, y, glyphs.tr);
  canvas.set(x, y + height - 1, glyphs.bl);
  canvas.set(x + width - 1, y + height - 1, glyphs.br);
  for (let column = x + 1; column < x + width - 1; column += 1) {
    canvas.set(column, y, glyphs.h);
    canvas.set(column, y + height - 1, glyphs.h);
  }
  for (let row = y + 1; row < y + height - 1; row += 1) {
    canvas.set(x, row, glyphs.v);
    canvas.set(x + width - 1, row, glyphs.v);
  }
};

const drawLoop = (canvas: CharacterCanvas, loop: GraphLayout["loops"][number], view: GraphViewModel, unicode: boolean): void => {
  const glyphs = unicode
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "┄", v: "┆" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: ".", v: ":" };
  canvas.set(loop.x, loop.y, glyphs.tl);
  canvas.set(loop.x + loop.width - 1, loop.y, glyphs.tr);
  canvas.set(loop.x, loop.y + loop.height - 1, glyphs.bl);
  canvas.set(loop.x + loop.width - 1, loop.y + loop.height - 1, glyphs.br);
  for (let x = loop.x + 1; x < loop.x + loop.width - 1; x += 1) {
    canvas.set(x, loop.y, glyphs.h);
    canvas.set(x, loop.y + loop.height - 1, glyphs.h);
  }
  for (let y = loop.y + 1; y < loop.y + loop.height - 1; y += 1) {
    canvas.set(loop.x, y, glyphs.v);
    canvas.set(loop.x + loop.width - 1, y, glyphs.v);
  }
  const viewLoop = view.loops.find((candidate) => candidate.id === loop.id);
  const iteration = viewLoop?.currentIteration ?? 0;
  const suffix = viewLoop?.status === "succeeded" ? " complete" : viewLoop?.status === "requires_revision" ? " revise" : "";
  canvas.text(loop.x + 2, loop.y, `loop ${loop.id} [${iteration}/${loop.maxIterations}]${suffix}`, Math.max(0, loop.width - 4));
};

const segmentGlyphs = (edge: GraphLayoutEdge, unicode: boolean): { horizontal: string; vertical: string } => {
  if (!unicode) {
    if (edge.kind === "feedback") return { horizontal: "=", vertical: "!" };
    if (edge.skipped) return { horizontal: ".", vertical: ":" };
    if (edge.selected) return { horizontal: "=", vertical: "#" };
    return { horizontal: "-", vertical: "|" };
  }
  if (edge.kind === "feedback") return { horizontal: "═", vertical: "║" };
  if (edge.skipped) return { horizontal: "┄", vertical: "┆" };
  if (edge.selected) return { horizontal: "━", vertical: "┃" };
  return { horizontal: "─", vertical: "│" };
};

const drawSegment = (
  canvas: CharacterCanvas,
  start: GraphPoint,
  end: GraphPoint,
  horizontal: string,
  vertical: string,
  unicode: boolean,
): void => {
  if (start.y === end.y) {
    const from = Math.min(start.x, end.x);
    const to = Math.max(start.x, end.x);
    for (let x = from; x <= to; x += 1) {
      const existing = canvas.get(x, start.y);
      canvas.set(x, start.y, existing === " " || existing === horizontal ? horizontal : unicode ? "┼" : "+");
    }
    return;
  }
  if (start.x === end.x) {
    const from = Math.min(start.y, end.y);
    const to = Math.max(start.y, end.y);
    for (let y = from; y <= to; y += 1) {
      const existing = canvas.get(start.x, y);
      canvas.set(start.x, y, existing === " " || existing === vertical ? vertical : unicode ? "┼" : "+");
    }
  }
};

const arrowFor = (previous: GraphPoint, end: GraphPoint, unicode: boolean): string => {
  if (end.x > previous.x) return unicode ? "▶" : ">";
  if (end.x < previous.x) return unicode ? "◀" : "<";
  if (end.y < previous.y) return unicode ? "▲" : "^";
  return unicode ? "▼" : "v";
};

const drawEdge = (canvas: CharacterCanvas, edge: GraphLayoutEdge, unicode: boolean): void => {
  const glyphs = segmentGlyphs(edge, unicode);
  for (let index = 1; index < edge.points.length; index += 1) {
    drawSegment(canvas, edge.points[index - 1]!, edge.points[index]!, glyphs.horizontal, glyphs.vertical, unicode);
  }
  const end = edge.points.at(-1);
  const previous = edge.points.at(-2);
  if (end && previous) canvas.set(end.x, end.y, arrowFor(previous, end, unicode));
};

const drawNode = (
  canvas: CharacterCanvas,
  layoutNode: GraphLayoutNode,
  view: GraphViewModel,
  selectedNodeId: string | undefined,
  unicode: boolean,
): void => {
  const node = view.nodes.find((candidate) => candidate.id === layoutNode.id);
  if (!node) return;
  drawRect(canvas, layoutNode.x, layoutNode.y, layoutNode.width, layoutNode.height, node.id === selectedNodeId, unicode);
  const innerWidth = Math.max(0, layoutNode.width - 2);
  const marker = (unicode ? STATUS_MARKERS : ASCII_STATUS_MARKERS)[node.status];
  canvas.text(layoutNode.x + 1, layoutNode.y + 1, truncate(`${marker} ${node.id}`, innerWidth), innerWidth);
  if (layoutNode.height >= 4) {
    canvas.text(layoutNode.x + 1, layoutNode.y + 2, truncate(node.title, innerWidth), innerWidth);
  }
  if (node.kind !== "task" && layoutNode.height >= 5) {
    canvas.text(layoutNode.x + 1, layoutNode.y + 3, truncate(`[${node.kind}]`, innerWidth), innerWidth);
  }
};

export function renderGraphScene(view: GraphViewModel, layout: GraphLayout, options: GraphRenderOptions): string[] {
  const unicode = options.unicode ?? true;
  const canvas = new CharacterCanvas(Math.max(1, layout.width), Math.max(1, layout.height));
  for (const loop of layout.loops) drawLoop(canvas, loop, view, unicode);
  for (const edge of layout.edges) drawEdge(canvas, edge, unicode);
  for (const node of layout.nodes) drawNode(canvas, node, view, options.selectedNodeId, unicode);
  return canvas.lines(
    Math.max(0, options.viewportX ?? 0),
    Math.max(0, options.viewportY ?? 0),
    Math.max(1, options.width),
    Math.max(1, options.height),
  );
}
