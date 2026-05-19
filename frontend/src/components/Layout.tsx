import { NavLink, Outlet, useNavigate, Link } from 'react-router-dom';
import { BookOpen, Search, Sparkles, RefreshCw, LogOut, Layers, Check, X, Upload, BarChart3, Library, Menu, LogIn, Server, Settings } from 'lucide-react';
import { auth, sync, update } from '../api';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AnkiWebLoginModal } from './AnkiWebLoginModal';
import { Logo } from './Logo';
import { AccountSwitcherModal } from './AccountSwitcherModal';
import { SyncConflictModal } from './SyncConflictModal';
import { UpdateModal } from './UpdateModal';

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';

export function Layout() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [syncMessage, setSyncMessage] = useState('');
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
    { to: '/quizlet', icon: () => <span className="font-bold text-sm leading-none" style={{ color: 'inherit' }}>Q</span>, label: 'Quizlet' },
    { to: '/search', icon: Search, label: t('nav.search') },
    { to: '/stats', icon: BarChart3, label: t('nav.stats') },
    { to: '/import', icon: Upload, label: t('nav.import') },
    { to: '/story', icon: Sparkles, label: t('nav.story') },
    { to: '/reading', icon: Library, label: t('nav.reading') },
  ];

  const mobileNavItems = navItems.slice(0, 5);
  const mobileMoreItems = navItems.slice(5);

  const handleSync = async () => {
    setSyncStatus('syncing');
    setSyncMessage('');
    try {
      await sync.trigger();
      setSyncStatus('success');
      setSyncMessage(t('sync.syncComplete'));
      // Dispatch event to notify components that sync completed
      window.dispatchEvent(new CustomEvent('anki-sync-complete'));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('sync.syncFailed');

      // Check if it's a sync conflict error (e.g. "Full sync required:download")
      if (errorMsg.includes('Full sync required')) {
        const rec = errorMsg.split(':')[1] as 'choose' | 'download' | 'upload' | undefined;
        setSyncConflictRecommendation(rec ?? 'choose');
        setShowSyncConflict(true);
        setSyncStatus('idle');
      } else {
        setSyncStatus('error');
        setSyncMessage(errorMsg);
      }
    }
  };

  const handleConflictResolved = () => {
    setSyncStatus('success');
    setSyncMessage(t('sync.syncComplete'));
    // Dispatch event to notify components that sync completed
    window.dispatchEvent(new CustomEvent('anki-sync-complete'));
  };

  // Auto-hide sync status after 3 seconds
  // Check for updates once on mount (admin only — silently ignore errors)
  useEffect(() => {
    update.check().then(r => { if (r.has_update) setHasUpdate(true); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (syncStatus === 'success' || syncStatus === 'error') {
      const timer = setTimeout(() => {
        setSyncStatus('idle');
        setSyncMessage('');
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [syncStatus]);

  const handleLogout = async () => {
    await auth.logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex flex-col bg-(--bg-primary)">
      {/* Header */}
      <header className="bg-(--bg-secondary)">
        <div className="max-w-7xl mx-auto px-2 sm:px-4 lg:px-8 h-14 flex items-center justify-between w-full gap-2">
          <Link to="/" className="flex items-center gap-2 hover-opacity-80 transition-opacity shrink-0">
            <Logo className="w-7 h-7" />
            <h1 className="text-lg sm:text-xl font-bold text-(--accent) hidden sm:block">AnkiBase</h1>
          </Link>

          <div className="flex items-center gap-1 sm:gap-2 shrink-0 overflow-x-auto">
            {/* Sync Status */}
            {syncStatus !== 'idle' && (
              <div
                className={`flex items-center gap-2 text-sm px-3 py-1 rounded-lg transition-opacity duration-300 ${
                  syncStatus === 'syncing'
                    ? 'text-(--text-secondary)'
                    : syncStatus === 'success'
                    ? 'text-green-400 bg-green-400/10'
                    : 'text-red-400 bg-red-400/10'
                }`}
              >
                {syncStatus === 'syncing' && <RefreshCw className="w-4 h-4 animate-spin" />}
                {syncStatus === 'success' && <Check className="w-4 h-4" />}
                {syncStatus === 'error' && <X className="w-4 h-4" />}
                <span className="hidden sm:inline">{syncStatus === 'syncing' ? t('sync.syncing') : syncMessage}</span>
              </div>
            )}

            {hasUpdate && (
              <button
                onClick={() => setShowUpdateModal(true)}
                className="btn flex items-center gap-2 px-2 sm:px-4 bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30"
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
                className={({ isActive }) =>
                  `relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                    isActive
                      ? 'text-(--accent)'
                      : 'text-(--text-secondary) hover-white'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon className="w-4 h-4" />
                    <span>{label}</span>
                    {isActive && (
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-(--accent)" />
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-4 pb-20 md:pb-4">
        <Outlet />
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-(--bg-secondary) border-t border-(--bg-tertiary) z-50">
        <div className="flex justify-around items-center h-16">
          {mobileNavItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center px-2 py-1 min-w-[60px] ${
                  isActive ? 'text-(--accent)' : 'text-(--text-secondary)'
                }`
              }
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
        onSuccess={() => {
          setSyncMessage('AnkiWeb login updated');
          setSyncStatus('success');
        }}
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
    </div>
  );
}
