import { useRef, useState, type ReactNode } from 'react';
import type { Layout, LayoutNode, Profile, PtyState, Session, SessionStatus } from '@shared/types';
import { shortcutLabel, type Platform } from '@shared/keymap';
import { useT } from '../i18n';
import { TerminalView } from '../terminal/TerminalView';
import { ProfileBadge, SessionStatusLabel } from './badges';
import { Button } from './Modal';
import { DND_PANE, DND_SESSION } from './TabBar';
import { useBranch } from './DiffPanel';

export interface PaneHandlers {
  onFocusPane(paneId: string): void;
  onShow(paneId: string, sessionId: string): void;
  onSwap(fromPaneId: string, toPaneId: string): void;
  onSplit(paneId: string, dir: 'row' | 'col'): void;
  onClosePane(paneId: string): void;
  onToggleMax(paneId: string): void;
  onPopout(sessionId: string): void;
  onDock(sessionId: string): void;
  onOpenExternal(sessionId: string): void;
  onReclaim(sessionId: string): void;
  onResize(splitId: string, sizes: number[]): void;
  onNewSession(): void;
}

interface Props extends PaneHandlers {
  layout: Layout;
  sessions: Map<string, Session>;
  profiles: Map<string, Profile>;
  tabs: Session[];
  statusOf(id: string): SessionStatus;
  ptyStates: Record<string, PtyState>;
  exitCodes: Record<string, number | null>;
  popouts: string[];
  platform: Platform;
}

/** The central pane area (§4): splits, resize, maximize, drag-and-drop, pop-out. */
export function PaneArea(props: Props) {
  const { layout } = props;
  const root: LayoutNode = layout.maximizedPaneId
    ? (findNode(layout.root, layout.maximizedPaneId) ?? layout.root)
    : layout.root;
  return (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-bg p-1" data-testid="pane-area">
      <Node node={root} {...props} />
    </div>
  );
}

function findNode(node: LayoutNode, id: string): LayoutNode | null {
  if (node.id === id) return node;
  if (node.kind === 'split')
    for (const c of node.children) {
      const f = findNode(c, id);
      if (f) return f;
    }
  return null;
}

function Node(props: Props & { node: LayoutNode }) {
  const { node } = props;
  if (node.kind === 'pane') return <PaneView {...props} paneId={node.id} sessionId={node.sessionId} />;
  return <SplitView {...props} node={node} />;
}

function SplitView(props: Props & { node: Extract<LayoutNode, { kind: 'split' }> }) {
  const t = useT();
  const { node } = props;
  const ref = useRef<HTMLDivElement>(null);
  const horizontal = node.dir === 'row';

  const startDrag = (index: number, e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    const start = horizontal ? e.clientX : e.clientY;
    const initial = [...node.sizes];
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / total;
      const sizes = [...initial];
      const pair = initial[index]! + initial[index + 1]!;
      sizes[index] = Math.min(pair - 0.08, Math.max(0.08, initial[index]! + delta));
      sizes[index + 1] = pair - sizes[index]!;
      props.onResize(node.id, sizes);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const onKey = (index: number, e: React.KeyboardEvent) => {
    const step = (horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']).indexOf(e.key);
    if (step < 0) return;
    e.preventDefault();
    const sizes = [...node.sizes];
    const d = step === 0 ? -0.03 : 0.03;
    sizes[index] = sizes[index]! + d;
    sizes[index + 1] = sizes[index + 1]! - d;
    props.onResize(node.id, sizes);
  };

  const children: ReactNode[] = [];
  node.children.forEach((child, i) => {
    if (i > 0)
      children.push(
        <div
          key={`gutter-${i}`}
          role="separator"
          aria-orientation={horizontal ? 'vertical' : 'horizontal'}
          aria-label={t('pane.resize')}
          aria-valuenow={Math.round(node.sizes[i - 1]! * 100)}
          tabIndex={0}
          className={`shrink-0 rounded bg-transparent hover:bg-accent/40 focus-visible:bg-accent/40 ${
            horizontal ? 'mx-px w-1 cursor-col-resize' : 'my-px h-1 cursor-row-resize'
          }`}
          onPointerDown={(e) => startDrag(i - 1, e)}
          onKeyDown={(e) => onKey(i - 1, e)}
        />,
      );
    children.push(
      <div key={child.id} className="flex min-h-0 min-w-0" style={{ flex: `${node.sizes[i]} 1 0` }}>
        <Node {...props} node={child} />
      </div>,
    );
  });
  return (
    <div ref={ref} className={`flex h-full w-full min-h-0 min-w-0 ${horizontal ? 'flex-row' : 'flex-col'}`}>
      {children}
    </div>
  );
}

function PaneView(props: Props & { paneId: string; sessionId: string | null }) {
  const t = useT();
  const { paneId, layout } = props;
  const session = props.sessionId ? props.sessions.get(props.sessionId) : undefined;
  const profile = session ? props.profiles.get(session.profileId) : undefined;
  const focused = layout.focusedPaneId === paneId;
  const maximized = layout.maximizedPaneId === paneId;
  const poppedOut = !!session && props.popouts.includes(session.id);
  const [dropping, setDropping] = useState(false);
  // Remote folders are not on this machine: no local git for SSH sessions.
  const branch = useBranch(session && !session.sshHostId ? session.cwd : null);
  const multiple = layout.root.kind === 'split';

  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    const sid = e.dataTransfer.getData(DND_SESSION);
    const pid = e.dataTransfer.getData(DND_PANE);
    if (sid) props.onShow(paneId, sid);
    else if (pid && pid !== paneId) props.onSwap(pid, paneId);
  };
  const accepts = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(DND_SESSION) || e.dataTransfer.types.includes(DND_PANE);

  const btn = 'rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg';
  const tip = (label: string, action?: Parameters<typeof shortcutLabel>[0]) => {
    const key = action ? shortcutLabel(action, props.platform) : '';
    return key ? `${label} (${key})` : label;
  };

  return (
    <section
      className={`relative flex h-full w-full min-w-0 flex-col overflow-hidden rounded border ${
        focused ? 'border-accent' : 'border-line'
      }`}
      style={{ borderLeft: `3px solid ${profile?.color ?? 'var(--color-line)'}` }}
      aria-label={t('pane.label', { title: session?.title ?? t('pane.empty') })}
      data-testid="pane"
      data-pane-id={paneId}
      data-focused={focused}
      onMouseDownCapture={() => !focused && props.onFocusPane(paneId)}
      onFocusCapture={() => !focused && props.onFocusPane(paneId)}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <header
        className="flex h-8 shrink-0 cursor-grab items-center gap-2 border-b border-line bg-panel px-2 text-xs"
        draggable={multiple}
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_PANE, paneId);
          e.dataTransfer.effectAllowed = 'move';
        }}
        title={multiple ? t('pane.dragHint') : undefined}
        data-testid="pane-header"
      >
        {session ? (
          <>
            <ProfileBadge profile={profile} small />
            <span className="min-w-0 truncate font-medium">{session.title}</span>
            <SessionStatusLabel status={props.statusOf(session.id)} />
            {session.sshHostId && (
              <span
                className="shrink-0 rounded border border-line px-1 text-[11px] text-muted"
                title={t('ssh.sessionHint')}
                data-testid="pane-ssh"
              >
                SSH
              </span>
            )}
            {branch && (
              <span
                className="font-path shrink-0 text-muted"
                title={`git: ${branch}`}
                data-testid="pane-branch"
              >
                ⎇ {branch}
              </span>
            )}
            <span className="font-path min-w-0 flex-1 truncate text-muted" title={session.cwd}>
              {session.cwd}
            </span>
          </>
        ) : (
          <span className="flex-1 text-muted">{t('pane.empty')}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {session && session.location === 'embedded' && !poppedOut && (
            <>
              {!session.sshHostId && (
                <button
                  className={btn}
                  onClick={() => props.onOpenExternal(session.id)}
                  title={t('session.openExternal')}
                  aria-label={t('session.openExternal')}
                >
                  ↗
                </button>
              )}
              <button
                className={btn}
                onClick={() => props.onPopout(session.id)}
                title={tip(t('pane.popout'), 'popout')}
                aria-label={t('pane.popout')}
                data-testid="pane-popout"
              >
                ⧉
              </button>
            </>
          )}
          <button
            className={btn}
            onClick={() => props.onSplit(paneId, 'row')}
            title={tip(t('pane.splitRight'), 'splitRight')}
            aria-label={t('pane.splitRight')}
            data-testid="pane-split-right"
          >
            ◫
          </button>
          <button
            className={btn}
            onClick={() => props.onSplit(paneId, 'col')}
            title={tip(t('pane.splitDown'), 'splitDown')}
            aria-label={t('pane.splitDown')}
            data-testid="pane-split-down"
          >
            ⊟
          </button>
          {multiple && (
            <>
              <button
                className={btn}
                onClick={() => props.onToggleMax(paneId)}
                title={tip(maximized ? t('pane.restore') : t('pane.maximize'), 'maximize')}
                aria-label={maximized ? t('pane.restore') : t('pane.maximize')}
                aria-pressed={maximized}
                data-testid="pane-maximize"
              >
                {maximized ? '⤡' : '⤢'}
              </button>
              <button
                className={btn}
                onClick={() => props.onClosePane(paneId)}
                title={tip(t('pane.close'), 'closePane')}
                aria-label={t('pane.close')}
                data-testid="pane-close"
              >
                ✕
              </button>
            </>
          )}
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        {session && session.location === 'embedded' && !poppedOut && (
          <TerminalView
            key={session.id}
            session={session}
            focused={focused}
            ptyState={props.ptyStates[session.id] ?? 'idle'}
            exitCode={props.exitCodes[session.id] ?? null}
          />
        )}
        {session && poppedOut && (
          <Placeholder>
            <p className="text-base font-semibold">⧉ {t('pane.poppedOut')}</p>
            <Button variant="primary" onClick={() => props.onDock(session.id)}>
              {t('pane.dock')}
            </Button>
          </Placeholder>
        )}
        {session?.location === 'external' && (
          <Placeholder>
            <p className="text-base font-semibold">↗ {t('session.external.banner')}</p>
            <p className="text-muted">{t('session.external.limits')}</p>
            <Button variant="primary" onClick={() => props.onReclaim(session.id)}>
              {t('session.reclaim')}
            </Button>
          </Placeholder>
        )}
        {!session && (
          <Placeholder>
            <p className="font-semibold">{t('pane.empty')}</p>
            <p className="text-xs text-muted">{t('pane.emptyHint')}</p>
            <ul className="max-h-64 space-y-1 overflow-y-auto text-left" data-testid="pane-picker">
              {props.tabs.map((s) => (
                <li key={s.id}>
                  <button
                    className="flex w-full items-center gap-2 rounded border border-line px-2 py-1 hover:bg-panel-2"
                    onClick={() => props.onShow(paneId, s.id)}
                  >
                    <ProfileBadge profile={props.profiles.get(s.profileId)} small />
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    <SessionStatusLabel status={props.statusOf(s.id)} compact />
                  </button>
                </li>
              ))}
            </ul>
            <Button onClick={props.onNewSession}>＋ {t('session.new')}</Button>
          </Placeholder>
        )}
        {dropping && (
          <div className="pointer-events-none absolute inset-0 z-20 bg-accent/15 ring-2 ring-accent ring-inset" />
        )}
      </div>
    </section>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-y-auto bg-bg p-4">
      <div className="w-[360px] max-w-full space-y-3 rounded-lg border border-line bg-panel p-5 text-center">
        {children}
      </div>
    </div>
  );
}
