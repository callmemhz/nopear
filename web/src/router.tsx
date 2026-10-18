import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { engine, ready } from './engine';
import { RootLayout, AppLayout } from './routes/root';
import { LoginPage } from './routes/login';
import { AuthCallbackPage } from './routes/auth-callback';
import { HomePage } from './routes/home';
import { SessionPage } from './routes/session';
import { MachinesPage } from './routes/machines';
import { ClaimPage } from './routes/claim';
import { MemoryPage } from './routes/memory';
import { ProjectsPage } from './routes/projects';
import { BoardPage } from './routes/board';
import { ProjectPage } from './routes/project';
import { GlobalMemoryPage } from './routes/global-memory';
import { SettingsPage } from './routes/settings';
import { AdminPage } from './routes/admin';

const rootRoute = createRootRoute({ component: RootLayout });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (s: Record<string, unknown>) => ({ redirect: typeof s.redirect === 'string' ? s.redirect : undefined }),
  component: LoginPage,
});
const authCallbackRoute = createRoute({ getParentRoute: () => rootRoute, path: '/auth/callback', component: AuthCallbackPage });

/** Everything below requires a SaaS login; unauthenticated visits bounce to /login (with return path). */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ location }) => {
    await ready;
    if (!engine.store.getState().token) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: AppLayout,
});

const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: HomePage });
const sessionRoute = createRoute({ getParentRoute: () => appRoute, path: '/s/$workerId/$sessionId', component: SessionPage });
const machinesRoute = createRoute({ getParentRoute: () => appRoute, path: '/machines', component: MachinesPage });
const claimRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/claim',
  validateSearch: (s: Record<string, unknown>) => ({ w: typeof s.w === 'string' ? s.w : '', t: typeof s.t === 'string' ? s.t : '' }),
  component: ClaimPage,
});
const memoryRoute = createRoute({ getParentRoute: () => appRoute, path: '/memory/$workerId', component: MemoryPage });
const projectsRoute = createRoute({ getParentRoute: () => appRoute, path: '/projects', component: ProjectsPage });
const projectRoute = createRoute({ getParentRoute: () => appRoute, path: '/projects/$projectId', component: ProjectPage });
const boardRoute = createRoute({ getParentRoute: () => appRoute, path: '/board', component: BoardPage });
const globalMemoryRoute = createRoute({ getParentRoute: () => appRoute, path: '/memory', component: GlobalMemoryPage });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsPage });
const adminRoute = createRoute({ getParentRoute: () => appRoute, path: '/admin', component: AdminPage });

const routeTree = rootRoute.addChildren([
  loginRoute,
  authCallbackRoute,
  appRoute.addChildren([
    homeRoute, sessionRoute, machinesRoute, claimRoute, memoryRoute, globalMemoryRoute, projectsRoute, projectRoute, boardRoute, settingsRoute, adminRoute,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: false });
export { claimRoute, loginRoute, sessionRoute, memoryRoute };

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
