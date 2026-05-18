import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { auth, setup } from './api';
import { loadAccentColor } from './hooks/useAccentColor';

loadAccentColor();
import { Login } from './components/Login';
import { Layout } from './components/Layout';
import { Decks } from './components/Decks';
import { Study } from './components/Study';
import { Search } from './components/Search';
import { Stats } from './components/Stats';
import { Story } from './components/Story';
import { Reading } from './components/Reading';
import { Import } from './components/Import';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { NotFound } from './components/NotFound';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const { i18n } = useTranslation();
  const navigate = useNavigate();

  useEffect(() => {
    const check = async () => {
      try {
        const status = await setup.status();
        if (status.needs_setup || !status.has_container) {
          setNeedsSetup(true);
          return;
        }
        const res = await auth.check();
        setAuthenticated(res.authenticated);
        if (res.user?.language) i18n.changeLanguage(res.user.language);
      } catch {
        setAuthenticated(false);
      } finally {
        setChecking(false);
      }
    };
    check();
  }, [i18n, navigate]);

  if (needsSetup) return <Navigate to="/setup" replace />;

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="skeleton h-8 w-32 rounded-full" />
      </div>
    );
  }

  return authenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Decks />} />
          <Route path="study" element={<Study />} />
          <Route path="search" element={<Search />} />
          <Route path="stats" element={<Stats />} />
          <Route path="import" element={<Import />} />
          <Route path="story" element={<Story />} />
          <Route path="reading" element={<Reading />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
