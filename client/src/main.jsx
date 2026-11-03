import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.jsx';
import { EventsProvider } from './lib/events.jsx';
import { ToastProvider } from './lib/toast.jsx';
import Analytics from './pages/Analytics.jsx';
import Automation from './pages/Automation.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Insights from './pages/Insights.jsx';
import LiveMonitor from './pages/LiveMonitor.jsx';
import NotFound from './pages/NotFound.jsx';
import RunDetail from './pages/RunDetail.jsx';
import Runs from './pages/Runs.jsx';
import Settings from './pages/Settings.jsx';
import Suites from './pages/Suites.jsx';
import TestEditor from './pages/TestEditor.jsx';
import Tests from './pages/Tests.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <EventsProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="live" element={<LiveMonitor />} />
              <Route path="tests" element={<Tests />} />
              <Route path="tests/new" element={<TestEditor />} />
              <Route path="tests/:id" element={<TestEditor />} />
              <Route path="suites" element={<Suites />} />
              <Route path="runs" element={<Runs />} />
              <Route path="runs/:id" element={<RunDetail />} />
              <Route path="automation" element={<Automation />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="insights" element={<Insights />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </EventsProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
