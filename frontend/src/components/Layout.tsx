import { NavLink, Outlet, useNavigate, Link, useLocation } from 'react-router-dom';
import { BookOpen, Search, Sparkles, RefreshCw, LogOut, Layers, X, Upload, BarChart3, Library, Menu, Settings, CheckCircle, AlertCircle, CloudOff, ChevronDown } from 'lucide-react';
import { auth, update, type User } from '../api';
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Logo } from './Logo';
import { ProfilesModal } from './ProfilesModal';
import { SyncConflictModal } from './SyncConflictModal';
import { UpdateModal } from './UpdateModal';
import { createPortal } from 'react-dom';
import { MotionLayer } from './MotionLayer';
import { appStatus, hasServer, isNative, useAppStatus } from '../native';
import { runSync, useAutoSync, useSyncState, type SyncResult } from '../sync';

interface ToastData {
  id: number;
  icon: React.ReactNode;
  title: string;
  message: string;
  duration: number;
}

function Toast({ icon, title, message, duration, onClose }: Omit<ToastData, 'id'> & { onClose: () => void }) {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dismiss = () => {
    setExiting(true);
    timerRef.current = setTimeout(onClose, 250);
  };

  useEffect(() => {
    timerRef.current = setTimeout(dismiss, duration);
    return () => clearTimeout(timerRef.current);
  }, []);

  return (
    <div className={`w-full sm:w-80 max-w-sm bg-(--bg-secondary) border border-(--bg-tertiary) rounded-xl shadow-2xl overflow-hidden ${exiting ? 'toast-exit' : 'toast-enter'}`}>
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <span className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }}>{icon}</span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm leading-snug">{title}</p>
          <p className="text-xs text-(--text-secondary) mt-0.5 leading-relaxed">{message}</p>
        </div>
        <button onClick={dismiss} className="icon-btn shrink-0 -mt-0.5 -mr-1">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="h-0.5 bg-(--bg-tertiary)">
        <div
          className="h-full"
          style={{
            background: 'var(--accent)',
            transformOrigin: 'left',
            animation: `toastProgress ${duration}ms linear forwards`,
          }}
        />
      </div>
    </div>
  );
}

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const onStudyPath = location.pathname.startsWith('/anki/') || location.pathname.startsWith('/quizlet/');
  // Studying a deck on a phone: the answer buttons take the tab bar's place.
  const studyingAnki = location.pathname.startsWith('/anki/');
  const syncing = useSyncState() === 'syncing';
  const app = useAppStatus();
  const serverFeatures = hasServer(app);
  const offline = isNative && !!app?.server && !app.online;
  useAutoSync();
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const toastIdRef = useRef(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const [me, setMe] = useState<User | null>(null);
  useEffect(() => { auth.me().then(setMe).catch(() => {}); }, []);
  const can = (p: keyof NonNullable<User['permissions']>) => me?.permissions ? me.permissions[p] : true;
  const [showSyncConflict, setShowSyncConflict] = useState(false);
  const [syncConflictRecommendation, setSyncConflictRecommendation] = useState<'choose' | 'download' | 'upload'>('choose');
  const [hasUpdate, setHasUpdate] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  const navItems = [
    { to: '/', icon: Layers, label: t('nav.decks') },
    { to: '/study', icon: BookOpen, label: t('nav.study') },
    { to: '/search', icon: Search, label: t('nav.search') },
    { to: '/stats', icon: BarChart3, label: t('nav.stats') },
    ...(can('import') ? [{ to: '/import', icon: Upload, label: t('nav.import') }] : []),
    // Stories need the AnkiBase server (the AI and the saved stories live there).
    ...(serverFeatures && can('use_ai') ? [{ to: '/story', icon: Sparkles, label: t('nav.story') }] : []),
    ...(serverFeatures ? [{ to: '/reading', icon: Library, label: t('nav.reading') }] : []),
  ];

  const mobileNavItems = navItems.slice(0, 5);
  const mobileMoreItems = navItems.slice(5);

  const pushToast = (toast: Omit<ToastData, 'id'>) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { ...toast, id }]);
  };

  const removeToast = (id: number) => setToasts(prev => prev.filter(t => t.id !== id));

  // Sync results from anywhere (this button, Settings, automatic syncs): toasts, or the
  // "which copy wins" choice.
  useEffect(() => {
    const onResult = (event: Event) => {
      const result = (event as CustomEvent<SyncResult>).detail;
      if (result.kind === 'done') {
        pushToast({ icon: <CheckCircle className="w-5 h-5" />, title: 'Sync complete', message: 'Your cards are up to date.', duration: 3000 });
      } else if (result.kind === 'conflict') {
        setSyncConflictRecommendation(result.recommendation);
        setShowSyncConflict(true);
      } else if (result.kind === 'not-configured') {
        navigate('/settings?tab=sync');
      } else {
        pushToast({ icon: <AlertCircle className="w-5 h-5" />, title: 'Sync failed', message: result.message, duration: 6000 });
      }
    };
    window.addEventListener('anki-sync-result', onResult);
    return () => window.removeEventListener('anki-sync-result', onResult);
  }, [navigate]);

  const handleSync = () => { runSync(); };

  const handleConflictResolved = () => {
    window.dispatchEvent(new CustomEvent('anki-sync-complete'));
    pushToast({
      icon: <CheckCircle className="w-5 h-5" />,
      title: 'Sync complete',
      message: 'Your cards are up to date.',
      duration: 3000,
    });
  };

  useEffect(() => {
    // The app updates through SideStore; the server's own update is in Settings → Server.
    if (!isNative) update.check().then(r => { if (r.has_update) setHasUpdate(true); }).catch(() => {});
  }, []);

  const handleLogout = async () => {
    await auth.logout();
    navigate('/login');
  };

  const pending = app?.pending ?? 0;

  return (
    <div className="min-h-dvh flex flex-col bg-(--bg-primary)">
      {/* Header: stays put, and covers the status bar / Dynamic Island area while scrolling */}
      <header className="app-header sticky top-0 z-40 bg-(--bg-secondary)">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8 h-14 flex items-center justify-between w-full gap-2">
          <Link to="/" className="flex items-center gap-2 hover-opacity-80 transition-opacity shrink-0">
            <Logo className="w-7 h-7" />
            <h1 className="text-lg sm:text-xl font-bold text-(--accent)">AnkiBase</h1>
          </Link>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {offline && (
              <button onClick={() => appStatus.check()} title="Offline: tap to try again"
                className="h-9 px-2.5 rounded-lg flex items-center gap-1.5 text-xs font-medium bg-(--warning)/15 text-(--warning)">
                <CloudOff className="w-4 h-4" /> Offline{pending ? ` · ${pending}` : ''}
              </button>
            )}

            {hasUpdate && (
              <button
                onClick={() => setShowUpdateModal(true)}
                className="btn btn-primary flex items-center gap-2 px-2 sm:px-4"
                title="Update available"
              >
                <RefreshCw className="w-4 h-4" />
                <span className="hidden sm:inline">Update</span>
              </button>
            )}

            <button
              onClick={handleSync}
              disabled={syncing}
              className="btn btn-secondary header-btn flex items-center gap-2"
              title={t('sync.sync')}
              aria-label={t('sync.sync')}
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{t('sync.sync')}</span>
            </button>

            {!isNative && me && (
              <button
                onClick={() => setShowProfiles(true)}
                className="btn btn-secondary header-btn flex items-center gap-2 max-w-[11rem]"
                title={t('profiles.title')}
                aria-label={t('profiles.title')}
              >
                <Layers className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline truncate">{me.profile?.name ?? t('profiles.title')}</span>
                <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-60 hidden sm:inline" />
              </button>
            )}

            <Link
              to="/settings"
              className="btn btn-secondary header-btn flex items-center gap-2"
              title={t('settings.title')}
              aria-label={t('settings.title')}
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">{t('settings.title')}</span>
            </Link>

            {!isNative && (
              <button
                onClick={handleLogout}
                className="btn btn-secondary header-btn hidden sm:flex items-center gap-2"
                title={t('common.logout')}
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">{t('common.logout')}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Desktop Navigation - hidden on mobile */}
      <nav className="hidden md:block bg-(--bg-secondary) border-b border-(--bg-tertiary)">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full">
          <div className="flex gap-1">
            {navItems.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) => {
                  const active = isActive || (to === '/study' && onStudyPath);
                  return `nav-tab relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                    active ? 'text-(--accent)' : 'text-(--text-secondary) hover-white'
                  }`;
                }}
              >
                {({ isActive }) => {
                  const active = isActive || (to === '/study' && onStudyPath);
                  return (
                    <>
                      <Icon className="w-4 h-4" />
                      <span>{label}</span>
                      <span className={`nav-tab-underline absolute bottom-0 left-0 right-0 h-0.5 bg-(--accent) transition-transform duration-200 origin-center ${
                        active ? 'scale-x-100' : 'scale-x-0'
                      }`} />
                    </>
                  );
                }}
              </NavLink>
            ))}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="safe-pb-main flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-4">
        <div key={location.pathname} className="anim-page"><Outlet /></div>
        <MotionLayer />
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className={`app-tabbar md:hidden fixed ${studyingAnki ? 'hidden' : ''} bottom-0 left-0 right-0 bg-(--bg-secondary) border-t border-(--bg-tertiary) z-40`}>
        <div className="flex justify-around items-stretch h-14">
          {mobileNavItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => {
                const active = isActive || (to === '/study' && onStudyPath);
                return `flex-1 flex flex-col items-center justify-center gap-0.5 min-w-0 ${
                  active ? 'text-(--accent)' : 'text-(--text-secondary)'
                }`;
              }}
            >
              <Icon className="w-[22px] h-[22px]" />
              <span className="text-[10px] font-medium leading-tight truncate max-w-full px-1">{label}</span>
            </NavLink>
          ))}

          {mobileMoreItems.length > 0 && (
            <div className="relative flex-1 flex">
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 ${
                  mobileMenuOpen || mobileMoreItems.some(i => location.pathname.startsWith(i.to)) ? 'text-(--accent)' : 'text-(--text-secondary)'
                }`}
                aria-expanded={mobileMenuOpen}
              >
                <Menu className="w-[22px] h-[22px]" />
                <span className="text-[10px] font-medium leading-tight">{t('nav.more')}</span>
              </button>

              {mobileMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMobileMenuOpen(false)} />
                  <div className="absolute bottom-full right-2 mb-2 w-48 bg-(--bg-secondary) border border-(--bg-tertiary) rounded-xl shadow-2xl z-50 overflow-hidden anim-rise">
                    {mobileMoreItems.map(({ to, icon: Icon, label }) => (
                      <NavLink
                        key={to}
                        to={to}
                        onClick={() => setMobileMenuOpen(false)}
                        className={({ isActive }) =>
                          `flex items-center gap-3 px-4 py-3.5 text-sm ${
                            isActive
                              ? 'text-(--accent) bg-(--bg-tertiary)'
                              : 'text-(--text-primary) hover-bg-tertiary'
                          }`
                        }
                      >
                        <Icon className="w-4 h-4" />
                        <span>{label}</span>
                      </NavLink>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </nav>

      <ProfilesModal
        isOpen={showProfiles}
        onClose={() => setShowProfiles(false)}
        // Everything (decks, stories, Quizlet sets, AI keys) belongs to the profile: start fresh.
        onSwitch={() => window.location.reload()}
      />

      {/* Sync Conflict Modal */}
      <SyncConflictModal
        isOpen={showSyncConflict}
        recommendation={syncConflictRecommendation}
        onClose={() => setShowSyncConflict(false)}
        onResolved={handleConflictResolved}
      />

      <UpdateModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
      />

      {/* Toast notifications */}
      {toasts.length > 0 && createPortal(
        <div className="toast-stack fixed right-4 left-4 sm:left-auto z-[300] flex flex-col items-end gap-2 pointer-events-none">
          {toasts.map(toast => (
            <div key={toast.id} className="pointer-events-auto">
              <Toast
                icon={toast.icon}
                title={toast.title}
                message={toast.message}
                duration={toast.duration}
                onClose={() => removeToast(toast.id)}
              />
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
