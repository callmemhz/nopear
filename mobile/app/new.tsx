// 「新会话」 route (drawer 新会话 / a project group's ＋): optional ?projectId=&workerId= prefill.
import { useLocalSearchParams } from 'expo-router';
import { NewSession } from '../src/screens/NewSession';

export default function NewSessionRoute() {
  const p = useLocalSearchParams<{ projectId?: string; workerId?: string }>();
  const initial = { ...(p.projectId ? { projectId: String(p.projectId) } : {}), ...(p.workerId ? { workerId: String(p.workerId) } : {}) };
  // a new prefill (another project's ＋) starts a fresh form
  return <NewSession key={`${initial.projectId ?? ''}|${initial.workerId ?? ''}`} initial={initial} />;
}
