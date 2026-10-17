// Home: the most recent session's chat (opened once per login, as soon as sessions are known), else 「新会话」.
import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { latestSession } from '@nopear/core';
import { useEngine } from '../src/engine';
import { sessionHref } from '../src/format';
import { NewSession } from '../src/screens/NewSession';

/** Token the home screen already auto-opened the latest session for (once per login per launch). */
let autoOpenedFor: string | null = null;

export default function Home() {
  const token = useEngine((s) => s.token);
  const latest = useEngine((s) => {
    const l = latestSession(Object.values(s.sessions).flatMap((m) => Object.values(m)));
    return l ? sessionHref(l.workerId, l.id) : null;
  });
  const [dirty, setDirty] = useState(false);
  // only while focused: a notification may have pushed a chat on top, which must not be replaced
  useFocusEffect(useCallback(() => {
    if (!latest || dirty || !token || autoOpenedFor === token) return;
    autoOpenedFor = token;
    router.replace(latest as never);
  }, [latest, dirty, token]));
  return <NewSession onDirty={() => setDirty(true)} />;
}
