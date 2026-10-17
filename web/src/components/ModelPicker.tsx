import { THINKING_LEVELS, type ThinkingLevel } from '@nopear/protocol';
import { useEngine } from '../engine';

const THINKING_LABEL: Record<ThinkingLevel, string> = { off: '关闭', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最大' };

export function ModelPicker({ workerId, model, thinking, onChange, compact }: {
  workerId: string; model: string; thinking: ThinkingLevel;
  onChange: (v: { model: string; thinking: ThinkingLevel }) => void; compact?: boolean;
}) {
  const info = useEngine((s) => s.workerInfo[workerId]);
  const models = info?.models ?? [];
  // compact = borderless ghost selects for the composer toolbar
  const cls = compact
    ? 'h-7 max-w-44 cursor-pointer truncate rounded-md bg-transparent px-1.5 text-[12.5px] text-subtle outline-none hover:bg-hover hover:text-ink'
    : 'input';
  return (
    <div className={`flex items-center ${compact ? 'gap-0.5' : 'gap-2'}`}>
      <select className={cls} value={model} onChange={(e) => onChange({ model: e.target.value, thinking })} title="模型">
        {!models.some((m) => m.id === model) && model && <option value={model}>{model}</option>}
        {models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
      </select>
      <select className={cls} value={thinking} onChange={(e) => onChange({ model, thinking: e.target.value as ThinkingLevel })} title="思考强度">
        {THINKING_LEVELS.map((t) => <option key={t} value={t}>思考 · {THINKING_LABEL[t]}</option>)}
      </select>
    </div>
  );
}
