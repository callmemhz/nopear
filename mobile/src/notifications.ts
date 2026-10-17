// Local notifications (local only, no APNs). Engine notices → OS notifications; tap → open session.
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { sessionKey } from '@nopear/protocol';
import type { EngineNotice } from '@nopear/core';
import { engine } from './engine';

let activeKey: string | null = null;
/** The session currently on screen never triggers a notification. */
export function setActiveSession(workerId: string | null, sessionId: string | null) {
  activeKey = workerId && sessionId ? sessionKey(workerId, sessionId) : null;
}
/** Clear the active session only if it is still this one (a newer focused screen may own it). */
export function clearActiveSession(workerId: string, sessionId: string) {
  if (activeKey === sessionKey(workerId, sessionId)) activeKey = null;
}

const TITLES: Record<EngineNotice['kind'], string> = {
  'session.idle': '会话完成 ✅',
  'session.error': '会话出错 ⚠️',
  prompt: '需要你的回答 ❓',
};

export function noticeTarget(n: EngineNotice): string | null {
  if (n.sessionId) return `/s/${encodeURIComponent(n.workerId)}/${encodeURIComponent(n.sessionId)}`;
  return null;
}

let started = false;
/** Call once from the root layout. Returns a cleanup function. */
export function startNotifications(): () => void {
  if (started) return () => {};
  started = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
  void Notifications.getPermissionsAsync()
    .then((p) => (p.granted || !p.canAskAgain ? p : Notifications.requestPermissionsAsync()))
    .catch(() => {});

  const offNotice = engine.onNotice((n) => {
    if (n.sessionId && activeKey === sessionKey(n.workerId, n.sessionId)) return;
    const url = noticeTarget(n);
    void Notifications.scheduleNotificationAsync({
      content: { title: TITLES[n.kind], body: n.title, data: url ? { url } : {} },
      trigger: null,
    }).catch(() => {});
  });

  const open = (resp: Notifications.NotificationResponse | null) => {
    const url = resp?.notification.request.content.data?.url;
    if (typeof url === 'string') router.push(url as never);
  };
  const sub = Notifications.addNotificationResponseReceivedListener(open);

  return () => { offNotice(); sub.remove(); started = false; };
}

let coldStartHandled = false;
/**
 * Cold start via a notification tap: handle the last response only once the root navigator is ready
 * (call from the root layout when navigation state has a key), then clear it so it is not replayed.
 */
export function handleColdStartNotification(): void {
  if (coldStartHandled) return;
  coldStartHandled = true;
  void Notifications.getLastNotificationResponseAsync()
    .then((resp) => {
      const url = resp?.notification.request.content.data?.url;
      if (typeof url === 'string') router.push(url as never);
      if (resp) return Notifications.clearLastNotificationResponseAsync();
    })
    .catch(() => {});
}
