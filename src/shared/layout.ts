/**
 * Split-pane layout as an immutable tree (§4). Pure functions only, so the
 * same rules run in the renderer and in unit tests.
 *
 * Invariant: a session is shown in at most one pane (an xterm can live in one
 * place only); every split has ≥ 2 children whose sizes sum to 1.
 */
import type { Layout, LayoutNode, SplitDir } from './types';

type Pane = Extract<LayoutNode, { kind: 'pane' }>;
type Split = Extract<LayoutNode, { kind: 'split' }>;

let counter = 0;
export function newId(prefix = 'p'): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function singlePane(sessionId: string | null, id = newId()): Layout {
  return { root: { kind: 'pane', id, sessionId }, focusedPaneId: id, maximizedPaneId: null };
}

export function panes(node: LayoutNode): Pane[] {
  return node.kind === 'pane' ? [node] : node.children.flatMap(panes);
}

export function findPane(layout: Layout, paneId: string): Pane | null {
  return panes(layout.root).find((p) => p.id === paneId) ?? null;
}

export function paneOfSession(layout: Layout, sessionId: string): Pane | null {
  return panes(layout.root).find((p) => p.sessionId === sessionId) ?? null;
}

export function focusedPane(layout: Layout): Pane {
  return findPane(layout, layout.focusedPaneId) ?? panes(layout.root)[0]!;
}

function mapPanes(node: LayoutNode, fn: (p: Pane) => Pane): LayoutNode {
  if (node.kind === 'pane') return fn(node);
  return { ...node, children: node.children.map((c) => mapPanes(c, fn)) };
}

function withRoot(layout: Layout, root: LayoutNode): Layout {
  const ids = new Set(panes(root).map((p) => p.id));
  const first = panes(root)[0]!.id;
  return {
    root,
    focusedPaneId: ids.has(layout.focusedPaneId) ? layout.focusedPaneId : first,
    maximizedPaneId:
      layout.maximizedPaneId && ids.has(layout.maximizedPaneId) ? layout.maximizedPaneId : null,
  };
}

/**
 * Show a session in a pane. If it is already visible elsewhere, the two panes
 * swap contents so the session is never shown twice.
 */
export function showSession(layout: Layout, paneId: string, sessionId: string | null): Layout {
  const target = findPane(layout, paneId);
  if (!target) return layout;
  const other = sessionId ? paneOfSession(layout, sessionId) : null;
  const root = mapPanes(layout.root, (p) => {
    if (p.id === paneId) return { ...p, sessionId };
    if (other && p.id === other.id) return { ...p, sessionId: target.sessionId };
    return p;
  });
  return { ...withRoot(layout, root), focusedPaneId: paneId };
}

/** Split a pane; the new pane (focused) goes after it, sharing the old pane's space. */
export function splitPane(
  layout: Layout,
  paneId: string,
  dir: SplitDir,
  sessionId: string | null = null,
  id = newId(),
): Layout {
  const fresh: Pane = { kind: 'pane', id, sessionId: null };
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'pane') {
      if (node.id !== paneId) return node;
      return { kind: 'split', id: newId('s'), dir, children: [node, fresh], sizes: [0.5, 0.5] };
    }
    const idx = node.children.findIndex((c) => c.kind === 'pane' && c.id === paneId);
    if (idx >= 0 && node.dir === dir) {
      const half = node.sizes[idx]! / 2;
      const children = [...node.children];
      const sizes = [...node.sizes];
      children.splice(idx + 1, 0, fresh);
      sizes.splice(idx, 1, half, half);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(visit) };
  };
  if (!findPane(layout, paneId)) return layout;
  const next = { ...withRoot(layout, visit(layout.root)), focusedPaneId: id, maximizedPaneId: null };
  return sessionId ? showSession(next, id, sessionId) : next;
}

/** Remove a pane (its session stays open as a tab). The last pane is kept, emptied. */
export function closePane(layout: Layout, paneId: string): Layout {
  const all = panes(layout.root);
  if (all.length <= 1) return showSession(layout, paneId, null);
  const order = all.map((p) => p.id);
  const idx = order.indexOf(paneId);
  const prune = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === 'pane') return node.id === paneId ? null : node;
    const kept: { child: LayoutNode; size: number }[] = [];
    node.children.forEach((c, i) => {
      const n = prune(c);
      if (n) kept.push({ child: n, size: node.sizes[i]! });
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!.child;
    const total = kept.reduce((s, k) => s + k.size, 0);
    return { ...node, children: kept.map((k) => k.child), sizes: kept.map((k) => k.size / total) };
  };
  const root = prune(layout.root)!;
  const next = withRoot(layout, root);
  const neighbour = order[idx - 1] ?? order[idx + 1]!;
  return layout.focusedPaneId === paneId ? { ...next, focusedPaneId: neighbour } : next;
}

export function swapPanes(layout: Layout, a: string, b: string): Layout {
  const pa = findPane(layout, a);
  const pb = findPane(layout, b);
  if (!pa || !pb || a === b) return layout;
  const root = mapPanes(layout.root, (p) =>
    p.id === a ? { ...p, sessionId: pb.sessionId } : p.id === b ? { ...p, sessionId: pa.sessionId } : p,
  );
  return { ...withRoot(layout, root), focusedPaneId: b };
}

export function resizeSplit(layout: Layout, splitId: string, sizes: number[]): Layout {
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'pane') return node;
    if (node.id === splitId && sizes.length === node.children.length) {
      const min = 0.08;
      const clamped = sizes.map((s) => Math.max(min, s));
      const total = clamped.reduce((x, y) => x + y, 0);
      return { ...node, sizes: clamped.map((s) => s / total) };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return { ...layout, root: visit(layout.root) };
}

/** Empty every pane whose session is not in `keep` (closed tabs, popped-out windows, deleted sessions). */
export function retainSessions(layout: Layout, keep: Set<string>): Layout {
  let changed = false;
  const root = mapPanes(layout.root, (p) => {
    if (p.sessionId && !keep.has(p.sessionId)) {
      changed = true;
      return { ...p, sessionId: null };
    }
    return p;
  });
  return changed ? { ...layout, root } : layout;
}

export function toggleMaximize(layout: Layout, paneId = layout.focusedPaneId): Layout {
  if (panes(layout.root).length <= 1) return { ...layout, maximizedPaneId: null };
  return { ...layout, maximizedPaneId: layout.maximizedPaneId === paneId ? null : paneId };
}

export function focusRelative(layout: Layout, delta: number): Layout {
  const order = panes(layout.root).map((p) => p.id);
  const idx = Math.max(0, order.indexOf(layout.focusedPaneId));
  const next = order[(idx + delta + order.length) % order.length]!;
  return { ...layout, focusedPaneId: next, maximizedPaneId: layout.maximizedPaneId ? next : null };
}

export function setFocus(layout: Layout, paneId: string): Layout {
  return findPane(layout, paneId) ? { ...layout, focusedPaneId: paneId } : layout;
}

function isNode(x: unknown, depth = 0): x is LayoutNode {
  if (!x || typeof x !== 'object' || depth > 12) return false;
  const n = x as Record<string, unknown>;
  if (typeof n.id !== 'string') return false;
  if (n.kind === 'pane') return n.sessionId === null || typeof n.sessionId === 'string';
  if (n.kind !== 'split' || (n.dir !== 'row' && n.dir !== 'col')) return false;
  const { children, sizes } = n;
  return (
    Array.isArray(children) &&
    Array.isArray(sizes) &&
    children.length >= 2 &&
    children.length === sizes.length &&
    sizes.every((s) => typeof s === 'number' && s > 0) &&
    children.every((c) => isNode(c, depth + 1))
  );
}

/** Shape check for a layout read back from settings.json. */
export function isLayout(x: unknown): x is Layout {
  if (!x || typeof x !== 'object') return false;
  const l = x as Record<string, unknown>;
  if (!isNode(l.root) || typeof l.focusedPaneId !== 'string') return false;
  if (l.maximizedPaneId !== null && typeof l.maximizedPaneId !== 'string') return false;
  const all = panes(l.root);
  const ids = new Set(all.map((p) => p.id));
  const shown = all.map((p) => p.sessionId).filter(Boolean);
  return ids.size === all.length && new Set(shown).size === shown.length;
}

export type { Pane, Split };
