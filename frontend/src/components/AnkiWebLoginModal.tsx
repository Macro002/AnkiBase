import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Eye, EyeOff, LogIn, LogOut } from 'lucide-react';
import { ankiweb } from '../api';

interface AnkiWebLoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function AnkiWebLoginModal({ isOpen, onClose, onSuccess }: AnkiWebLoginModalProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentEmail, setCurrentEmail] = useState('');
  const [checkingStatus, setCheckingStatus] = useState(false);
  // Only the latest status check may update the modal (an abandoned one can answer late)
  const statusRequest = useRef(0);

  // Check status when modal opens - reset state first to show spinner
  useEffect(() => {
    if (isOpen) {
      // Reset to show spinner during check
      setIsLoggedIn(false);
      setCurrentEmail('');
      checkLoginStatus();
    }
  }, [isOpen]);

  const checkLoginStatus = async () => {
    const request = ++statusRequest.current;
    setCheckingStatus(true);
    try {
      const status = await ankiweb.status();
      if (request !== statusRequest.current) return;
      setIsLoggedIn(status.configured);
      setCurrentEmail(status.email || '');
    } catch (err) {
      console.error('Failed to check login status:', err);
    } finally {
      if (request === statusRequest.current) setCheckingStatus(false);
    }
  };

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Log in (Anki keeps the sync key; the password isn't stored)
      await ankiweb.login(email, password);
      setEmail('');
      setPassword('');
      setLoading(false);
      await checkLoginStatus(); // shows the account as Anki stored it
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ankiweb.loginFailed'));
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setError('');
    setLoading(true);

    try {
      await ankiweb.deleteCredentials();
      setIsLoggedIn(false);
      setCurrentEmail('');
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ankiweb.logoutFailed'));
    } finally {
      setLoading(false);
    }
  };

  // Don't close mid login/logout (a status check is fine to abandon)
  const canClose = !loading;

  const handleClose = () => {
    if (canClose) {
      onClose();
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-50"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="card max-w-md w-full" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <LogIn className="w-5 h-5 text-(--accent)" />
              <h2 className="text-xl font-bold">{t('ankiweb.title')}</h2>
            </div>
            {canClose && (
              <button onClick={handleClose} className="icon-btn">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Loading State */}
          {checkingStatus ? (
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <div className="relative w-16 h-16">
                {/* Outer ring */}
                <div className="absolute inset-0 rounded-full border-4 border-(--bg-tertiary)"></div>
                {/* Spinning arc */}
                <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-(--accent) animate-spin"></div>
              </div>
              <p className="text-sm text-(--text-secondary)">{t('ankiweb.checkingStatus')}</p>
            </div>
          ) : (
            <>
              {/* Info - only show when not logged in and not loading */}
              {!isLoggedIn && !loading && (
                <p className="text-(--text-secondary) text-sm mb-4">
                  {t('ankiweb.infoText')}
                </p>
              )}

              {/* Error */}
              {error && (
                <p className="text-(--error) text-sm mb-4">{error}</p>
              )}

              {isLoggedIn ? (
            /* Logged In View */
            loading ? (
              /* Logging out - only show spinner */
              <div className="flex flex-col items-center justify-center py-8 space-y-4">
                <div className="relative w-16 h-16">
                  {/* Outer ring */}
                  <div className="absolute inset-0 rounded-full border-4 border-(--bg-tertiary)"></div>
                  {/* Spinning arc */}
                  <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-(--accent) animate-spin"></div>
                </div>
                <p className="text-sm text-(--text-secondary)">{t('ankiweb.loggingOut')}</p>
              </div>
            ) : (
              /* Show logged in state with logout button */
              <div className="space-y-4">
                {/* Current Email */}
                <div className="p-4 bg-(--bg-tertiary) rounded-lg border border-(--bg-tertiary)">
                  <label className="block text-sm font-medium mb-1 text-(--text-secondary)">{t('ankiweb.loggedInAs')}</label>
                  <p className="text-lg font-mono text-(--accent)">{currentEmail}</p>
                </div>

                {/* Logout Button */}
                <button
                  onClick={handleLogout}
                  disabled={loading}
                  className="btn btn-secondary w-full flex items-center justify-center gap-2"
                >
                  <LogOut className="w-4 h-4" />
                  {t('ankiweb.logout')}
                </button>
              </div>
            )
          ) : (
            /* Login Form */
            <>
              {loading ? (
                <div className="flex flex-col items-center justify-center py-8 space-y-4">
                  <div className="relative w-16 h-16">
                    {/* Outer ring */}
                    <div className="absolute inset-0 rounded-full border-4 border-(--bg-tertiary)"></div>
                    {/* Spinning arc */}
                    <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-(--accent) animate-spin"></div>
                  </div>
                  <p className="text-sm text-(--text-secondary)">{t('ankiweb.loggingIn')}</p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-4">
                  {/* Email */}
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('ankiweb.email')}</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={t('ankiweb.emailPlaceholder')}
                      className="input w-full"
                      required
                      autoFocus
                    />
                  </div>

                  {/* Password */}
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('ankiweb.password')}</label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={t('ankiweb.password')}
                        className="input w-full pr-10 password-input"
                        required
                      />
                      {password && (
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-white cursor-pointer hover-opacity-80 transition-opacity"
                        >
                          {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <button
                    type="submit"
                    disabled={loading}
                    className="btn btn-primary w-full"
                  >
                    {t('ankiweb.saveCredentials')}
                  </button>

                  {/* Reset password link */}
                  <div className="text-center">
                    <a
                      href="https://ankiweb.net/account/reset-password"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-(--accent) hover-underline"
                    >
                      {t('ankiweb.forgotPassword')}
                    </a>
                  </div>
                </form>
              )}
            </>
          )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
