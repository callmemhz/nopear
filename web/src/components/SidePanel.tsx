import type { BackgroundTask } from '@nopear/protocol';
import { TasksPanel } from './TasksPanel';
import { FilesPanel } from './FilesPanel';
import { Icon } from './Icons';

export type SidePanelTab = 'tasks' | 'files';

export function SidePanel({ workerId, sessionId, tasks, tab, onTab, onClose }: {
  workerId: string; sessionId: string; tasks: BackgroundTask[]; tab: SidePanelTab; onTab: (t: SidePanelTab) => void; onClose: () => void;
}) {
  const t = (k: SidePanelTab, label: string) => (
    <button role="tab" aria-selected={tab === k} onClick={() => onTab(k)}
      className={`border-b-2 px-2 py-2.5 text-xs ${tab === k ? 'border-ink font-medium text-ink' : 'border-transparent text-subtle hover:text-ink'}`}>{label}</button>
  );
  return (
    <aside className="surface panel flex w-80 shrink-0 flex-col border-l">
      <div className="panel flex items-center gap-2 border-b px-2" role="tablist">
        {t('files', '文件')}{t('tasks', `后台任务${tasks.length ? ` · ${tasks.length}` : ''}`)}
        <button className="btn-icon ml-auto h-7 w-7" title="关闭侧栏" aria-label="关闭侧栏" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'tasks' ? <TasksPanel workerId={workerId} sessionId={sessionId} tasks={tasks} /> : <FilesPanel workerId={workerId} sessionId={sessionId} />}
      </div>
    </aside>
  );
}
