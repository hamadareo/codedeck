import { describe, expect, it } from 'vitest';
import {
  closePane,
  focusRelative,
  isLayout,
  paneOfSession,
  panes,
  resizeSplit,
  retainSessions,
  showSession,
  singlePane,
  splitPane,
  swapPanes,
  toggleMaximize,
} from '@shared/layout';
import type { Layout } from '@shared/types';

const ids = (l: Layout) => panes(l.root).map((p) => p.sessionId);

describe('layout tree', () => {
  it('splits a pane; the new pane is focused and shares the space', () => {
    let l = singlePane('a', 'p1');
    l = splitPane(l, 'p1', 'row', 'b', 'p2');
    expect(ids(l)).toEqual(['a', 'b']);
    expect(l.focusedPaneId).toBe('p2');
    expect(l.root.kind === 'split' && l.root.sizes).toEqual([0.5, 0.5]);
    // Same-direction split inserts beside, halving only that pane.
    l = splitPane(l, 'p2', 'row', 'c', 'p3');
    expect(l.root.kind === 'split' && l.root.children.length).toBe(3);
    expect(l.root.kind === 'split' && l.root.sizes).toEqual([0.5, 0.25, 0.25]);
    // Other direction nests.
    l = splitPane(l, 'p1', 'col', null, 'p4');
    expect(ids(l)).toEqual(['a', null, 'b', 'c']);
    expect(isLayout(l)).toBe(true);
  });

  it('regression: a session is never shown in two panes (showing it again swaps)', () => {
    let l = splitPane(singlePane('a', 'p1'), 'p1', 'row', 'b', 'p2');
    l = showSession(l, 'p1', 'b');
    expect(ids(l)).toEqual(['b', 'a']);
    l = splitPane(l, 'p2', 'col', 'b', 'p3'); // "b" moves into the new pane
    expect(ids(l).filter((x) => x === 'b')).toHaveLength(1);
    expect(paneOfSession(l, 'b')?.id).toBe('p3');
  });

  it('closing a pane collapses its split and keeps sizes normalized; the last pane survives empty', () => {
    let l = splitPane(singlePane('a', 'p1'), 'p1', 'row', 'b', 'p2');
    l = splitPane(l, 'p2', 'col', 'c', 'p3');
    l = closePane(l, 'p3');
    expect(ids(l)).toEqual(['a', 'b']);
    expect(l.focusedPaneId).toBe('p2');
    l = closePane(l, 'p1');
    expect(l.root).toEqual({ kind: 'pane', id: 'p2', sessionId: 'b' });
    l = closePane(l, 'p2');
    expect(l.root).toEqual({ kind: 'pane', id: 'p2', sessionId: null });
  });

  it('swap, maximize, focus cycling', () => {
    let l = splitPane(singlePane('a', 'p1'), 'p1', 'row', 'b', 'p2');
    l = swapPanes(l, 'p1', 'p2');
    expect(ids(l)).toEqual(['b', 'a']);
    expect(l.focusedPaneId).toBe('p2'); // focus follows the dragged content
    l = toggleMaximize(l, 'p2');
    expect(l.maximizedPaneId).toBe('p2');
    l = focusRelative(l, 1);
    expect(l.focusedPaneId).toBe('p1');
    expect(l.maximizedPaneId).toBe('p1'); // the maximized view follows focus
    l = toggleMaximize(l, 'p1');
    expect(l.maximizedPaneId).toBeNull();
    expect(toggleMaximize(singlePane('x'), undefined).maximizedPaneId).toBeNull();
  });

  it('resize clamps tiny panes and renormalizes', () => {
    const l = splitPane(singlePane('a', 'p1'), 'p1', 'row', 'b', 'p2');
    const sid = l.root.kind === 'split' ? l.root.id : '';
    const r = resizeSplit(l, sid, [0.99, 0.01]);
    const sizes = r.root.kind === 'split' ? r.root.sizes : [];
    expect(sizes[1]).toBeGreaterThan(0.05);
    expect(sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });

  it('retainSessions empties panes of closed sessions', () => {
    const l = splitPane(singlePane('a', 'p1'), 'p1', 'row', 'b', 'p2');
    expect(ids(retainSessions(l, new Set(['b'])))).toEqual([null, 'b']);
    expect(retainSessions(l, new Set(['a', 'b']))).toBe(l);
  });

  it('isLayout rejects broken or duplicate data from settings.json', () => {
    expect(isLayout(null)).toBe(false);
    expect(
      isLayout({
        root: { kind: 'pane', id: 'p', sessionId: null },
        focusedPaneId: 'p',
        maximizedPaneId: null,
      }),
    ).toBe(true);
    const dup = {
      root: {
        kind: 'split',
        id: 's',
        dir: 'row',
        children: [
          { kind: 'pane', id: 'a', sessionId: 'x' },
          { kind: 'pane', id: 'b', sessionId: 'x' },
        ],
        sizes: [0.5, 0.5],
      },
      focusedPaneId: 'a',
      maximizedPaneId: null,
    };
    expect(isLayout(dup)).toBe(false);
    expect(isLayout({ ...dup, root: { ...dup.root, sizes: [1] } })).toBe(false);
  });
});
