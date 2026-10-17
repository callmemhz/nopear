// Session actions shared by the drawer (long-press) and the chat top bar (… menu).
import { Alert, Platform } from 'react-native';
import type { Project, Session } from '@nopear/protocol';
import { engine, errorText } from './engine';
import { actionMenu, type MenuOption } from './QuickAdd';

type Ref = Pick<Session, 'id' | 'workerId' | 'title'>;
const fail = (title: string) => (e: unknown) => Alert.alert(title, errorText(e));

export function renameSession(s: Ref) {
  if (Platform.OS === 'ios') {
    Alert.prompt('重命名', undefined, (t) => {
      if (t?.trim()) engine.updateSession(s.workerId, s.id, { title: t.trim() }).catch(fail('失败'));
    }, 'plain-text', s.title);
  } else {
    Alert.alert('重命名', '请在 iOS 上使用此功能');
  }
}

/** 项目标签 picker: every project (✓ on the current one) + 清除标签. */
export function projectTagOptions(s: Pick<Session, 'id' | 'workerId' | 'projectId'>, projects: Record<string, Project>): MenuOption[] {
  const setTag = (projectId: string | null) => void engine.updateSession(s.workerId, s.id, { projectId }).catch(fail('设置项目标签失败'));
  const list = Object.values(projects).sort((a, b) => a.name.localeCompare(b.name));
  return [
    ...list.map((p) => ({ label: p.id === s.projectId ? `✓ ${p.name}` : p.name, run: () => setTag(p.id) })),
    ...(s.projectId ? [{ label: '清除标签', destructive: true, run: () => setTag(null) }] : []),
  ];
}

export function pickProjectTag(s: Pick<Session, 'id' | 'workerId' | 'projectId'>, projects: Record<string, Project>) {
  const options = projectTagOptions(s, projects);
  if (options.length === 0) { Alert.alert('还没有项目', '在 web 控制台新建项目后即可给会话打标签'); return; }
  actionMenu('项目标签', options);
}

const patch = (s: Ref, p: { pinned?: boolean; starred?: boolean; archived?: boolean }) =>
  void engine.updateSession(s.workerId, s.id, p).catch(fail('失败'));

/** 置顶 / 星标 / 归档 toggles. */
export function flagOptions(s: Session): MenuOption[] {
  return [
    { label: s.pinned ? '取消置顶' : '置顶', run: () => patch(s, { pinned: !s.pinned }) },
    { label: s.starred ? '取消星标' : '星标', run: () => patch(s, { starred: !s.starred }) },
    { label: s.archived ? '取消归档' : '归档', destructive: !s.archived, run: () => patch(s, { archived: !s.archived }) },
  ];
}

/** Long-press menu of a session row in the drawer. */
export function sessionRowMenu(s: Session, projects: Record<string, Project>) {
  const tag = s.projectId ? projects[s.projectId]?.name ?? s.projectId : null;
  const [pin, star, archive] = flagOptions(s);
  actionMenu(s.title || '未命名会话', [
    pin!, star!,
    { label: tag ? `项目：${tag}…` : '设置项目标签…', run: () => pickProjectTag(s, projects) },
    { label: '重命名', run: () => renameSession(s) },
    archive!,
  ]);
}
