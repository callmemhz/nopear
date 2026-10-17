import { useEffect } from 'react';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { engine, useEngine } from '../engine';
import { Sidebar } from '../components/Sidebar';
import { OfflineBanner } from '../components/OfflineBanner';

export function RootLayout() {
  const error = useEngine((s) => s.error);
  return (
    <>
      <Outlet />
      {error && (
        <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 shadow-lg dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <span>{error}</span>
          <button className="text-xs underline" onClick={() => engine.store.setState({ error: null })}>关闭</button>
        </div>
      )}
    </>
  );
}

export function AppLayout() {
  // init() no longer waits for /api/me when a cached snapshot is shown: a token found invalid afterwards
  // (or any later 401 logout) clears it here → back to /login.
  const token = useEngine((s) => s.token);
  const navigate = useNavigate();
  useEffect(() => {
    if (!token) void navigate({ to: '/login', search: { redirect: location.pathname + location.search } });
  }, [token, navigate]);
  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-app">
        <OfflineBanner />
        <div className="min-h-0 flex-1"><Outlet /></div>
      </main>
    </div>
  );
}

/** Show an error toast through the engine store. */
export function reportError(e: unknown) {
  engine.store.setState({ error: e instanceof Error ? e.message : String(e) });
}
