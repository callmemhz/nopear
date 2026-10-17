import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Attachment, ThinkingLevel } from '@nopear/protocol';
import { engine, useEngine } from '../engine';
import { ModelPicker } from './ModelPicker';
import { AttachmentPicker, AttachmentChips } from './Composer';
import { CwdField } from './DirPicker';
import { usePasteAttachments } from '../lib/usePasteAttachments';

/** `initial`: prefill from a sidebar project group (its project tag, and a machine that has a path for it). */
export function NewSessionDialog({ onClose, initial }: { onClose: () => void; initial?: { workerId?: string; projectId?: string } }) {
  const machines = useEngine((s) => s.machines);
  const conn = useEngine((s) => s.machineConn);
  const infos = useEngine((s) => s.workerInfo);
  const online = useMemo(() => Object.values(machines).filter((m) => m.online && conn[m.workerId] !== 'offline'), [machines, conn]);
  const projects = useEngine((s) => s.projects);
  const projectList = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const projectPath = (w: string, pid = projectId) => (pid && projects[pid]?.paths[w]) || '';
  const [workerId, setWorkerId] = useState(() =>
    (initial?.workerId && online.some((m) => m.workerId === initial.workerId) ? initial.workerId : online[0]?.workerId) ?? '');
  const info = infos[workerId];
  const [cwd, setCwd] = useState(() => projectPath(workerId));
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState<ThinkingLevel>('medium');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();
  const attach = usePasteAttachments({ current: attachments, onAdd: (a) => setAttachments((prev) => [...prev, ...a]), onError: setErr });

  const selectedOnline = online.some((m) => m.workerId === workerId);
  // keep a usable selection: if the chosen machine goes offline (or none chosen), switch to another online one
  useEffect(() => {
    if (!selectedOnline && online[0]) setWorkerId(online[0].workerId);
  }, [online, selectedOnline]);
  // apply worker defaults only when the target machine changes (not on every workerInfo refresh)
  const appliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!info || appliedFor.current === workerId) return;
    appliedFor.current = workerId;
    setCwd(projectPath(workerId) || info.defaultCwd); setModel(info.defaultModel); setThinking(info.defaultThinking);
  }, [info, workerId]);

  const submit = async () => {
    if (!workerId || !selectedOnline || (!text.trim() && attachments.length === 0)) return;
    setBusy(true); setErr(null);
    try {
      const args: Parameters<typeof engine.createSession>[1] = { text, thinking };
      if (cwd.trim()) args.cwd = cwd.trim();
      if (title.trim()) args.title = title.trim();
      if (projectId) args.projectId = projectId;
      if (model) args.model = model;
      if (attachments.length) args.attachments = attachments;
      const s = await engine.createSession(workerId, args);
      onClose();
      void navigate({ to: '/s/$workerId/$sessionId', params: { workerId, sessionId: s.id } });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-6 pt-[12vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div data-testid="attach-drop" data-dragging={attach.dragging} {...(online.length ? attach.dropProps : {})}
        className={`card w-full max-w-xl space-y-3 p-5 shadow-2xl ${attach.dragging ? 'ring-2 ring-sky-400/60' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-[15px] font-semibold">新建会话</h2>
        {online.length === 0 ? (
          <p className="muted text-sm">没有在线的机器。先在「机器」页认领一台并让它的 worker 在线。</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <label className="space-y-1 text-xs"><span className="muted">机器</span>
                <select className="input" value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
                  {online.map((m) => <option key={m.workerId} value={m.workerId}>{m.label || m.workerId}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-xs"><span className="muted">项目</span>
                <select className="input" title="项目标签" value={projectId}
                  onChange={(e) => { setProjectId(e.target.value); const p = projectPath(workerId, e.target.value); if (p) setCwd(p); }}>
                  <option value="">无项目</option>
                  {projectId && !projects[projectId] && <option value={projectId}>{projectId}</option>}
                  {projectList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-xs"><span className="muted">标题（可选）</span>
                <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="自动生成" />
              </label>
            </div>
            <CwdField workerId={workerId} value={cwd} onChange={setCwd} placeholder={info?.defaultCwd} />
            <ModelPicker workerId={workerId} model={model} thinking={thinking} onChange={(v) => { setModel(v.model); setThinking(v.thinking); }} />
            <textarea
              className="input min-h-28 resize-y" autoFocus value={text} onChange={(e) => setText(e.target.value)}
              placeholder="要它做什么？（⌘/Ctrl + Enter 发送；可直接粘贴或拖入图片/文件）"
              onPaste={attach.onPaste}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
            />
            <AttachmentChips items={attachments} onRemove={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))} />
            {err && <p className="text-sm text-red-600">{err}</p>}
            <div className="flex items-center justify-between">
              <AttachmentPicker busy={attach.busy} onFiles={attach.addFiles} />
              <div className="flex gap-2">
                <button className="btn-ghost" onClick={onClose}>取消</button>
                <button className="btn-primary" disabled={busy || !selectedOnline || (!text.trim() && !attachments.length)} onClick={() => void submit()}>{busy ? '创建中…' : '开始'}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
