import { useMemo, useRef, useState, type DragEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { canDropOn, dropPatch, groupBoard, type BoardColumns, type MachineConn } from '@nopear/core';
import type { Card, CardMoveState, CardState, Machine, Project } from '@nopear/protocol';
import { engine, useEngine } from '../engine';
import { NO_PROJECT } from '../components/SessionList';
import { reportError } from './root';


interface Column {
  key: string;            // data-column: 'inbox' | 'queued:<workerId>' | 'running' | 'review' | 'done'
  title: string;
  state: CardState;
  workerId: string | null;
  cards: Card[];          // visible (filtered) cards
  all: Card[];            // unfiltered column (end-of-column order is computed over it)
  offline: boolean;
}

function columns(view: BoardColumns, full: BoardColumns, machines: Record<string, Machine>, conn: Record<string, MachineConn>): Column[] {
  const workers = Object.values(machines).sort((a, b) => (a.label || a.workerId).localeCompare(b.label || b.workerId)).map((m) => m.workerId);
  for (const w of Object.keys(full.queued)) if (!workers.includes(w)) workers.push(w); // queued to a machine we don't list
  const simple = (state: 'inbox' | 'running' | 'review' | 'done', title: string): Column =>
    ({ key: state, title, state, workerId: null, cards: view[state], all: full[state], offline: false });
  return [
    simple('inbox', '收件箱'),
    ...workers.map((w): Column => {
      const m = machines[w];
      return {
        key: `queued:${w}`, title: `待开始 · ${m?.label || w}`, state: 'queued', workerId: w,
        cards: view.queued[w] ?? [], all: full.queued[w] ?? [], offline: !m?.online || conn[w] === 'offline',
      };
    }),
    simple('running', '进行中'),
    simple('review', '待验收'),
    simple('done', '完成'),
  ];
}

/** Order for a card dropped into `col`: before `before` (between its visible neighbours) or at the end (last + 1). */
function dropOrder(col: Column, cardId: string, before?: Card): number | undefined {
  if (before) {
    const visible = col.cards.filter((c) => c.id !== cardId);
    const prev = visible[visible.indexOf(before) - 1];
    return prev ? (prev.order + before.order) / 2 : before.order - 1;
  }
  const last = col.all.filter((c) => c.id !== cardId).at(-1);
  return last ? last.order + 1 : undefined; // empty column: server appends
}

function CardItem({ c, projects, machines, onDragStart, onDragEnd, onDragOver, onDrop }: {
  c: Card; projects: Record<string, Project>; machines: Record<string, Machine>;
  onDragStart: (e: DragEvent, id: string) => void; onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void;
}) {
  const project = c.projectId ? projects[c.projectId] : undefined;
  const remove = () => {
    const note = c.state === 'running' ? '（执行中的会话会被中断）' : '';
    if (!confirm(`删除卡片「${c.title}」？${note}`)) return;
    engine.deleteCard(c.id).catch(reportError);
  };
  return (
    <div data-card={c.id} draggable onDragStart={(e) => onDragStart(e, c.id)} onDragEnd={onDragEnd} onDragOver={onDragOver} onDrop={onDrop}
      className="card group block w-full cursor-grab p-2.5 text-left text-xs">
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1 font-medium">{c.title}</div>
        <button type="button" data-action="delete" title="删除卡片" aria-label="删除卡片" draggable={false} onClick={remove}
          className="muted shrink-0 hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0">删除</button>
      </div>
      {c.body && <div className="muted mt-1 line-clamp-2 whitespace-pre-wrap">{c.body}</div>}
      <div className="muted mt-1 flex flex-wrap items-center gap-1">
        {project && <span className="chip">{project.name}</span>}
        {c.workerId && <span className="chip">{machines[c.workerId]?.label || c.workerId}</span>}
        {c.workerId && c.sessionId && (
          <Link to="/s/$workerId/$sessionId" params={{ workerId: c.workerId, sessionId: c.sessionId }} className="hover:underline" draggable={false}>会话 →</Link>
        )}
      </div>
      {c.error && <div className="mt-1 text-red-500">{c.error}</div>}
    </div>
  );
}

export function BoardPage() {
  const cards = useEngine((s) => s.cards);
  const projects = useEngine((s) => s.projects);
  const machines = useEngine((s) => s.machines);
  const conn = useEngine((s) => s.machineConn);
  const [filter, setFilter] = useState(''); // '' = all, NO_PROJECT = cards without a project, else a project id
  const dragging = useRef<string | null>(null);

  const cols = useMemo(() => {
    const list = Object.values(cards);
    const view = groupBoard(list, filter === '' ? undefined : filter === NO_PROJECT ? null : filter);
    return columns(view, groupBoard(list), machines, conn);
  }, [cards, filter, machines, conn]);
  const projectList = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);

  const onDragStart = (e: DragEvent, id: string) => {
    dragging.current = id;
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  };
  const onDragEnd = () => { dragging.current = null; };
  const onDragOver = (col: Column) => (e: DragEvent) => {
    if (!canDropOn(col.state)) return; // not calling preventDefault = drop not allowed
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (col: Column, before?: Card) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canDropOn(col.state)) return;
    const id = e.dataTransfer?.getData('text/plain') || dragging.current;
    dragging.current = null;
    if (!id || id === before?.id || !cards[id]) return;
    const patch = dropPatch(col.state as CardMoveState, col.workerId, dropOrder(col, id, before));
    engine.updateCard(id, patch).catch(reportError);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="panel flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-sm font-semibold">看板</h1>
        <select data-filter="project" className="input h-7 w-48 py-0 text-xs" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">全部项目</option>
          <option value={NO_PROJECT}>无项目</option>
          {projectList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="muted text-xs">拖到某台机器的「待开始」列即由该机器执行</span>
      </header>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {cols.map((col) => (
          <div key={col.key} data-column={col.key} onDragOver={onDragOver(col)} onDrop={onDrop(col)}
            className={`surface panel flex w-64 shrink-0 flex-col rounded-lg border ${col.offline ? 'offline opacity-60' : ''}`}>
            <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium">
              <h2 className="truncate">{col.title}</h2>
              <span className="muted">{col.cards.length}</span>
              {col.offline && <span className="muted">离线</span>}
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
              {col.cards.map((c) => (
                <CardItem key={c.id} c={c} projects={projects} machines={machines}
                  onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onDragOver(col)} onDrop={onDrop(col, c)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
