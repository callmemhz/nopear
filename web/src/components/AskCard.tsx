import { useState } from 'react';
import type { Prompt } from '@nopear/protocol';
import { engine } from '../engine';
import { reportError } from '../routes/root';

export function AskCard({ workerId, prompt }: { workerId: string; prompt: Prompt }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (q: string, label: string, multi: boolean) => setPicked((p) => {
    const cur = p[q] ?? [];
    const next = multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    return { ...p, [q]: next };
  });
  const answerOf = (q: string) => custom[q]?.trim() || (picked[q] ?? []).join(', ');
  const complete = prompt.questions.every((q) => answerOf(q.question));
  const submit = async () => {
    setBusy(true);
    try {
      const answers: Record<string, string> = {};
      for (const q of prompt.questions) answers[q.question] = answerOf(q.question);
      await engine.answerPrompt(workerId, prompt.sessionId, prompt.id, answers, note.trim() || undefined);
    } catch (e) { reportError(e); setBusy(false); }
  };

  return (
    <div className="mx-auto my-3 max-w-[720px] rounded-2xl border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-800/70 dark:bg-amber-950/20">
      <div className="mb-3 text-xs font-medium text-amber-700 dark:text-amber-400">❓ 需要你的回答</div>
      <div className="space-y-4">
        {prompt.questions.map((q) => (
          <div key={q.question} className="space-y-2">
            <div className="text-sm"><span className="chip mr-2">{q.header}</span>{q.question}{q.multiSelect && <span className="muted ml-1 text-xs">（可多选）</span>}</div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {q.options.map((o) => {
                const on = (picked[q.question] ?? []).includes(o.label);
                return (
                  <button key={o.label} onClick={() => toggle(q.question, o.label, q.multiSelect)}
                    className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${on ? 'border-ink bg-elev' : 'panel bg-elev/60 hover:bg-elev'}`}>
                    <div className="font-medium">{q.multiSelect ? (on ? '☑ ' : '☐ ') : (on ? '● ' : '○ ')}{o.label}</div>
                    {o.description && <div className="muted mt-0.5 text-xs">{o.description}</div>}
                  </button>
                );
              })}
            </div>
            <input className="input text-xs" placeholder="或者自己写答案…" value={custom[q.question] ?? ''} onChange={(e) => setCustom({ ...custom, [q.question]: e.target.value })} />
          </div>
        ))}
        <textarea className="input min-h-14 text-xs" placeholder="补充说明（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex justify-end"><button className="btn-primary" disabled={!complete || busy} onClick={() => void submit()}>{busy ? '提交中…' : '提交回答'}</button></div>
      </div>
    </div>
  );
}
