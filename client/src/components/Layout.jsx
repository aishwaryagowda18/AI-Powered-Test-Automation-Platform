import {
  Activity,
  BarChart3,
  CalendarClock,
  FlaskConical,
  History,
  LayoutDashboard,
  Layers,
  Menu,
  Moon,
  Play,
  Settings,
  Sparkles,
  Sun,
  Zap,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useEvents, useEventsStatus } from '../lib/events.jsx';
import { RunModal } from './RunModal.jsx';

const RunLauncherContext = createContext(() => {});
export const useRunLauncher = () => useContext(RunLauncherContext);

const PageMetaContext = createContext(() => {});
/** Pages call this to set the title/subtitle shown in the top bar. */
export function usePageMeta(title, subtitle) {
  const set = useContext(PageMetaContext);
  useEffect(() => {
    set({ title, subtitle });
    document.title = title ? `${title} · TestForge AI` : 'TestForge AI';
  }, [set, title, subtitle]);
}

const NAV = [
  { section: 'Overview' },
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/live', label: 'Live monitor', icon: Activity, live: true },
  { section: 'Testing' },
  { to: '/tests', label: 'Test cases', icon: FlaskConical },
  { to: '/suites', label: 'Suites', icon: Layers },
  { to: '/runs', label: 'Run history', icon: History },
  { to: '/automation', label: 'Schedules & alerts', icon: CalendarClock },
  { section: 'Intelligence' },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/insights', label: 'AI insights', icon: Sparkles },
  { section: 'Workspace' },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('tf-theme', next);
    } catch {
      /* storage unavailable */
    }
    setTheme(next);
  };
  return [theme, toggle];
}

export function Layout() {
  const connected = useEventsStatus();
  const location = useLocation();
  const [theme, toggleTheme] = useTheme();
  const [meta, setMeta] = useState({ title: '', subtitle: '' });
  const [launcher, setLauncher] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [activeRuns, setActiveRuns] = useState(0);
  const [ai, setAi] = useState(null);

  const refreshActive = useCallback(() => {
    api
      .get('/health')
      .then((h) => {
        setActiveRuns(h.activeRuns);
        setAi(h.ai);
      })
      .catch(() => {});
  }, []);
  useEffect(refreshActive, [refreshActive]);
  useEvents((e) => {
    if (e.type === 'run:created' || e.type === 'run:finished') refreshActive();
  });
  useEffect(() => setNavOpen(false), [location.pathname]);

  const openLauncher = useCallback((preset = {}) => setLauncher(preset), []);

  return (
    <RunLauncherContext.Provider value={openLauncher}>
      <PageMetaContext.Provider value={setMeta}>
        <div className="app">
          {navOpen && <div className="sidebar-scrim" onClick={() => setNavOpen(false)} />}
          <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
            <NavLink to="/" className="brand">
              <span className="brand-mark">
                <Zap size={18} />
              </span>
              <span className="brand-name">
                TestForge <span>AI</span>
              </span>
            </NavLink>
            <nav aria-label="Main">
              {NAV.map((item, i) =>
                item.section ? (
                  <div key={i} className="nav-section">
                    {item.section}
                  </div>
                ) : (
                  <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                    <item.icon size={17} />
                    {item.label}
                    {item.live && activeRuns > 0 && <span className="count">{activeRuns}</span>}
                  </NavLink>
                ),
              )}
            </nav>
            <div className="sidebar-foot">
              <strong>{!ai?.enabled ? 'Heuristic analysis' : ai.lastError ? `${ai.providerLabel} unavailable` : `${ai.providerLabel} AI on`}</strong>
              {!ai?.enabled
                ? 'Add a GEMINI_API_KEY to unlock AI root-cause analysis, test generation and fixes.'
                : ai.lastError
                  ? `${ai.lastError} Using heuristic analysis meanwhile.`
                  : `Failures are diagnosed by ${ai.model}.`}
            </div>
          </aside>

          <div className="main">
            <header className="topbar">
              <button className="btn btn-ghost btn-icon menu-btn" onClick={() => setNavOpen(true)} aria-label="Open navigation">
                <Menu size={18} />
              </button>
              <div className="topbar-title">
                <h1>{meta.title}</h1>
                {meta.subtitle && <p className="truncate">{meta.subtitle}</p>}
              </div>
              <span className="live-pill" title={connected ? 'Receiving live updates' : 'Reconnecting to live updates…'}>
                <span className={`dot ${connected ? 'dot-live' : ''}`} />
                <span className="btn-label">{connected ? 'Live' : 'Offline'}</span>
              </span>
              <button className="btn btn-ghost btn-icon" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
                {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
              </button>
              <button className="btn btn-primary" onClick={() => openLauncher()}>
                <Play size={15} />
                <span className="btn-label">Run tests</span>
              </button>
            </header>
            <main className="content">
              <Outlet />
            </main>
          </div>
        </div>
        {launcher && <RunModal preset={launcher} onClose={() => setLauncher(null)} />}
      </PageMetaContext.Provider>
    </RunLauncherContext.Provider>
  );
}
