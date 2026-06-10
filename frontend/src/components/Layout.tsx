import { NavLink, Outlet, useNavigate, Link, useLocation } from 'react-router-dom';
import { BookOpen, Search, Sparkles, RefreshCw, LogOut, Layers, X, Upload, BarChart3, Library, Menu, LogIn, Server, Settings, CheckCircle, AlertCircle } from 'lucide-react';
import { auth, sync, update } from '../api';
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AnkiWebLoginModal } from './AnkiWebLoginModal';
import { Logo } from './Logo';
import { AccountSwitcherModal } from './AccountSwitcherModal';
import { SyncConflictModal } from './SyncConflictModal';
import { UpdateModal } from './UpdateModal';
import { createPortal } from 'react-dom';

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';

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
    <div className={`w-80 bg-(--bg-secondary) border border-(--bg-tertiary) rounded-xl shadow-2xl overflow-hidden ${exiting ? 'toast-exit' : 'toast-enter'}`}>
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
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const toastIdRef = useRef(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showAnkiWebModal, setShowAnkiWebModal] = useState(false);
  const [showAccountSwitcher, setShowAccountSwitcher] = useState(false);
  const [showSyncConflict, setShowSyncConflict] = useState(false);
  const [syncConflictRecommendation, setSyncConflictRecommendation] = useState<'choose' | 'download' | 'upload'>('choose');
  const [hasUpdate, setHasUpdate] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  const navItems = [
    { to: '/', icon: Layers, label: t('nav.decks') },
    { to: '/study', icon: BookOpen, label: t('nav.study') },
    { to: '/search', icon: Search, label: t('nav.search') },
    { to: '/stats', icon: BarChart3, label: t('nav.stats') },
    { to: '/import', icon: Upload, label: t('nav.import') },
    { to: '/story', icon: Sparkles, label: t('nav.story') },
    { to: '/reading', icon: Library, label: t('nav.reading') },
  ];

  const mobileNavItems = navItems.slice(0, 5);
  const mobileMoreItems = navItems.slice(5);

  const pushToast = (toast: Omit<ToastData, 'id'>) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { ...toast, id }]);
  };

  const removeToast = (id: number) => setToasts(prev => prev.filter(t => t.id !== id));

  const handleSync = async () => {
    setSyncStatus('syncing');
    try {
      await sync.trigger();
      setSyncStatus('idle');
      window.dispatchEvent(new CustomEvent('anki-sync-complete'));
      pushToast({
        icon: <CheckCircle className="w-5 h-5" />,
        title: 'Sync complete',
        message: 'Your cards are up to date.',
        duration: 3000,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('sync.syncFailed');
      setSyncStatus('idle');

      if (errorMsg.includes('Full sync required')) {
        const rec = errorMsg.split(':')[1] as 'choose' | 'download' | 'upload' | undefined;
        setSyncConflictRecommendation(rec ?? 'choose');
        setShowSyncConflict(true);
      } else {
        pushToast({
          icon: <AlertCircle className="w-5 h-5" />,
          title: 'Sync failed',
          message: errorMsg,
          duration: 6000,
        });
      }
    }
  };

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
    update.check().then(r => { if (r.has_update) setHasUpdate(true); }).catch(() => {});
  }, []);

  const handleLogout = async () => {
    await auth.logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex flex-col bg-(--bg-primary)">
      {/* Header */}
      <header className="bg-(--bg-secondary)" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="max-w-7xl mx-auto px-2 sm:px-4 lg:px-8 h-14 flex items-center justify-between w-full gap-2">
          <Link to="/" className="flex items-center gap-2 hover-opacity-80 transition-opacity shrink-0">
            <Logo className="w-7 h-7" />
            <h1 className="text-lg sm:text-xl font-bold text-(--accent) hidden sm:block">AnkiBase</h1>
          </Link>

          <div className="flex items-center gap-1 sm:gap-2 shrink-0 overflow-x-auto">

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
              disabled={syncStatus === 'syncing'}
              className="btn btn-secondary flex items-center gap-2 px-2 sm:px-4"
              title={t('sync.sync')}
            >
              <RefreshCw className={`w-4 h-4 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{t('sync.sync')}</span>
            </button>

            <button
              onClick={() => setShowAnkiWebModal(true)}
              className="btn btn-secondary flex items-center gap-2 px-2 sm:px-4"
              title={t('ankiweb.title')}
            >
              <LogIn className="w-4 h-4" />
              <span className="hidden sm:inline">AnkiWeb</span>
            </button>

            <button
              onClick={() => setShowAccountSwitcher(true)}
              className="btn btn-secondary flex items-center gap-2 px-2 sm:px-4"
              title={t('accounts.switchAccount')}
            >
              <Server className="w-4 h-4" />
              <span className="hidden sm:inline">{t('accounts.switch')}</span>
            </button>

            <Link
              to="/settings"
              className="btn btn-secondary flex items-center gap-2 px-2 sm:px-4"
              title={t('settings.title')}
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">{t('settings.title')}</span>
            </Link>

            <button
              onClick={handleLogout}
              className="btn btn-secondary flex items-center gap-2 px-2 sm:px-4"
              title={t('common.logout')}
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">{t('common.logout')}</span>
            </button>
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
        <Outlet />
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-(--bg-secondary) border-t border-(--bg-tertiary) z-50" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div className="flex justify-around items-center h-16">
          {mobileNavItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => {
                const active = isActive || (to === '/study' && onStudyPath);
                return `flex flex-col items-center justify-center px-2 py-1 min-w-[60px] ${
                  active ? 'text-(--accent)' : 'text-(--text-secondary)'
                }`;
              }}
            >
              <Icon className="w-5 h-5" />
              <span className="text-xs mt-1">{label}</span>
            </NavLink>
          ))}

          {/* More menu for additional items */}
          <div className="relative">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className={`flex flex-col items-center justify-center px-2 py-1 min-w-[60px] ${
                mobileMenuOpen ? 'text-(--accent)' : 'text-(--text-secondary)'
              }`}
            >
              <Menu className="w-5 h-5" />
              <span className="text-xs mt-1">{t('nav.more')}</span>
            </button>

            {/* Dropdown menu */}
            {mobileMenuOpen && (
              <>
                {/* Backdrop */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setMobileMenuOpen(false)}
                />
                {/* Menu */}
                <div className="absolute bottom-full right-0 mb-2 w-40 bg-(--bg-secondary) border border-(--bg-tertiary) rounded-lg shadow-xl z-50 overflow-hidden">
                  {mobileMoreItems.map(({ to, icon: Icon, label }) => (
                    <NavLink
                      key={to}
                      to={to}
                      onClick={() => setMobileMenuOpen(false)}
                      className={({ isActive }) =>
                        `flex items-center gap-3 px-4 py-3 text-sm ${
                          isActive
                            ? 'text-(--accent) bg-(--bg-tertiary)'
                            : 'text-(--text-secondary) hover-bg-tertiary hover-white'
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
        </div>
      </nav>

      {/* Account Switcher Modal */}
      <AccountSwitcherModal
        isOpen={showAccountSwitcher}
        onClose={() => setShowAccountSwitcher(false)}
        onSwitch={() => {
          // Reload the entire page to refresh all data (API keys, stories, etc.)
          window.location.reload();
        }}
      />

      {/* AnkiWeb Login Modal */}
      <AnkiWebLoginModal
        isOpen={showAnkiWebModal}
        onClose={() => setShowAnkiWebModal(false)}
        onSuccess={() => pushToast({
          icon: <CheckCircle className="w-5 h-5" />,
          title: 'AnkiWeb connected',
          message: 'Your credentials have been saved.',
          duration: 3000,
        })}
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
        <div className="fixed top-[3.75rem] right-4 z-[300] flex flex-col gap-2 pointer-events-none">
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
