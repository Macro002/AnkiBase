import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2, Circle, Pencil, UserCircle2, RotateCw } from 'lucide-react';
import { accounts, auth, type AnkiAccount, type User } from '../api';

interface AccountSwitcherModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSwitch: () => void;
}

export function AccountSwitcherModal({ isOpen, onClose, onSwitch }: AccountSwitcherModalProps) {
  const { t } = useTranslation();
  const [accountList, setAccountList] = useState<AnkiAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  // Add/rename state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [renameModal, setRenameModal] = useState<{ account: AnkiAccount; newName: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ account: AnkiAccount; removeData: boolean } | null>(null);

  // Track restarting containers
  const [restartingContainers, setRestartingContainers] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (isOpen) {
      loadAccounts();
      loadCurrentUser();
    }
  }, [isOpen]);

  const loadCurrentUser = async () => {
    try {
      const user = await auth.me();
      setCurrentUser(user);
    } catch (err) {
      console.error('Failed to load current user:', err);
    }
  };

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const data = await accounts.list();

      // Accounts already have ankiweb_email from database
      setAccountList(data.accounts);
      setActiveAccountId(data.active_account_id);
      setError('');
    } catch (err) {
      console.error('Failed to load accounts:', err);
      setError(err instanceof Error ? err.message : t('accounts.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchAccount = async (accountId: number) => {
    if (accountId === activeAccountId) return;

    setError('');
    setLoading(true);

    try {
      await accounts.switch(accountId);
      await loadAccounts();
      onSwitch();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accounts.switchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    setError('');
    setLoading(true);

    try {
      await accounts.create(newName.trim());
      await loadAccounts();
      setNewName('');
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accounts.addFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleRenameAccount = async () => {
    if (!renameModal || !renameModal.newName.trim()) return;

    setError('');
    setLoading(true);

    try {
      // TODO: Add rename endpoint to backend
      // For now, just close the modal
      setRenameModal(null);
      // await accounts.rename(renameModal.account.id, renameModal.newName.trim());
      // await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accounts.renameFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!deleteConfirm) return;

    setError('');
    setLoading(true);

    try {
      await accounts.delete(deleteConfirm.account.id, deleteConfirm.removeData);
      await loadAccounts();
      setDeleteConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accounts.deleteFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleRestartContainer = async (accountId: number) => {
    setError('');

    // Mark container as restarting
    setRestartingContainers(prev => new Set(prev).add(accountId));

    try {
      // Trigger the restart
      await accounts.restart(accountId);

      // Poll until container is back up (check every 2 seconds, max 30 seconds)
      const maxAttempts = 15;
      let attempts = 0;

      const checkContainerStatus = async (): Promise<boolean> => {
        try {
          // Try to load accounts - if this succeeds, container is back
          await accounts.list();
          return true;
        } catch {
          return false;
        }
      };

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const isUp = await checkContainerStatus();

        if (isUp) {
          // Container is back up
          await loadAccounts();
          break;
        }

        attempts++;
      }

      if (attempts >= maxAttempts) {
        setError(t('accounts.restartTimeout'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accounts.restartFailed'));
    } finally {
      // Remove from restarting set
      setRestartingContainers(prev => {
        const newSet = new Set(prev);
        newSet.delete(accountId);
        return newSet;
      });
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="card max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <UserCircle2 className="w-5 h-5 text-(--accent)" />
              <h2 className="text-xl font-bold">{t('accounts.switchAccount')}</h2>
            </div>
            <button onClick={onClose} className="icon-btn">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Info */}
          <p className="text-(--text-secondary) text-sm mb-4">
            {t('accounts.selectAccount')}
          </p>

          {/* Account List */}
          {loading && accountList.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-(--accent)"></div>
            </div>
          ) : (
            <div className="space-y-3 mb-4">
              {accountList.map((account, index) => {
                const isActive = account.id === activeAccountId;
                // Only use ankiweb_email from database, not the placeholder email field
                const ankiwebEmail = account.ankiweb_email;
                const hasAnkiweb = !!ankiwebEmail;
                const isRestarting = restartingContainers.has(account.id);

                return (
                  <div
                    key={account.id}
                    className={`p-4 rounded-lg border transition-all relative ${
                      isActive
                        ? 'border-green-500/30 bg-green-500/5'
                        : 'border-(--bg-tertiary) hover-border-accent'
                    }`}
                  >
                    {/* Action buttons - top right */}
                    <div className="absolute top-3 right-3 flex items-center gap-1">
                      {/* Restart button */}
                      <button
                        onClick={() => handleRestartContainer(account.id)}
                        className="icon-btn"
                        title={t('accounts.restartContainer')}
                        disabled={loading || isRestarting}
                      >
                        <RotateCw className={`w-4 h-4 ${isRestarting ? 'animate-spin' : ''}`} />
                      </button>

                      {/* Rename button */}
                      <button
                        onClick={() => setRenameModal({ account, newName: account.container_name })}
                        className="icon-btn"
                        title={t('accounts.renameTooltip')}
                        disabled={loading}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>

                      {/* Delete button */}
                      <button
                        onClick={() => setDeleteConfirm({ account, removeData: false })}
                        className="icon-btn icon-btn-danger"
                        title={t('accounts.deleteTooltip')}
                        disabled={loading || accountList.length === 1}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Container name with status */}
                    <div className="flex items-center gap-2 mb-2 pr-32">
                      <h3 className="font-semibold text-lg truncate">{account.container_name}</h3>
                      {isRestarting ? (
                        <span className="text-xs px-2 py-0.5 bg-yellow-500/20 text-yellow-400 rounded whitespace-nowrap flex items-center gap-1">
                          <RotateCw className="w-2 h-2 animate-spin" />
                          {t('accounts.restarting', 'Restarting')}
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-400 rounded whitespace-nowrap flex items-center gap-1">
                          <Circle className="w-2 h-2 fill-green-400 text-green-400" />
                          {t('accounts.running', 'Running')}
                        </span>
                      )}
                    </div>

                    {/* AnkiWeb status - show for all accounts */}
                    {hasAnkiweb ? (
                      <p className="text-sm mb-2">
                        AnkiWeb: <span className="font-mono text-green-400">{ankiwebEmail}</span>
                      </p>
                    ) : (
                      <p className="text-sm text-yellow-400 mb-2">{t('accounts.notLoggedIntoAnkiWeb', 'Not logged into AnkiWeb')}</p>
                    )}

                    {/* Container details */}
                    <p className="text-xs text-(--text-secondary) mb-2">
                      [Index: {index + 1}] [Port: {account.container_port}] [Volume: {account.volume_name}]
                    </p>

                    {/* Select button - bottom right */}
                    <div className="flex justify-end">
                      <button
                        onClick={() => !isActive && handleSwitchAccount(account.id)}
                        className={`btn btn-sm ${isActive ? 'btn-secondary opacity-50 cursor-not-allowed' : 'btn-primary'}`}
                        disabled={loading || isActive}
                      >
                        {isActive ? t('accounts.active', 'Active') : t('accounts.select', 'Select')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Add Account Section - only show if user has permission */}
          {(currentUser?.can_add_containers || currentUser?.is_admin) && (
            showAddForm ? (
              <form onSubmit={handleAddAccount} className="p-4 border border-(--bg-tertiary) rounded-lg">
                <label className="block text-sm font-medium mb-2">{t('accounts.containerName', 'Container Name')}</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t('accounts.containerPlaceholder', 'e.g., personal, work, study')}
                  className="input w-full mb-3"
                  required
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddForm(false);
                      setNewName('');
                    }}
                    className="btn btn-secondary flex-1"
                    disabled={loading}
                  >
                    {t('common.cancel')}
                  </button>
                  <button type="submit" disabled={loading} className="btn btn-primary flex-1">
                    {loading ? t('accounts.creating', 'Creating...') : t('accounts.create', 'Create')}
                  </button>
                </div>
              </form>
            ) : (
              <button
                onClick={() => setShowAddForm(true)}
                className="btn btn-primary w-full flex items-center justify-center gap-2"
                disabled={loading}
              >
                <Plus className="w-4 h-4" />
                {t('accounts.addContainer', 'Add Container')}
              </button>
            )
          )}
        </div>
      </div>

      {/* Rename Modal */}
      {renameModal && (
        <div className="fixed inset-0 bg-black/50 z-60 flex items-center justify-center p-4">
          <div className="card max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">{t('accounts.renameContainer', 'Rename Container')}</h3>
              <button onClick={() => setRenameModal(null)} className="icon-btn">
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              value={renameModal.newName}
              onChange={(e) => setRenameModal({ ...renameModal, newName: e.target.value })}
              className="input w-full mb-4"
              placeholder={t('accounts.containerName', 'Container name')}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleRenameAccount()}
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setRenameModal(null)} className="btn btn-secondary" disabled={loading}>
                {t('common.cancel')}
              </button>
              <button
                onClick={handleRenameAccount}
                className="btn btn-primary"
                disabled={loading || !renameModal.newName.trim()}
              >
                {loading ? t('decks.renaming') : t('decks.rename')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 z-60 flex items-center justify-center p-4">
          <div className="card max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold">{t('accounts.deleteAccount', 'Delete Account')}</h3>
              <button onClick={() => setDeleteConfirm(null)} className="icon-btn">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-(--text-secondary) mb-4">
              {t('accounts.deleteConfirm', 'Are you sure you want to delete')}{' '}
              <span className="text-white font-semibold">{deleteConfirm.account.container_name}</span>?
            </p>

            {/* Remove data checkbox */}
            <label className="flex items-start gap-2 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteConfirm.removeData}
                onChange={(e) => setDeleteConfirm({ ...deleteConfirm, removeData: e.target.checked })}
                className="mt-0.5 w-4 h-4 rounded border-gray-600 bg-(--bg-tertiary) text-(--accent)"
              />
              <span className="text-sm">
                {t('accounts.deleteData', 'Also delete all data (Docker volume)')}
                <span className="block text-xs text-red-400 mt-1">
                  {t('accounts.deleteWarning', 'Warning: This will permanently delete all cards and data!')}
                </span>
              </span>
            </label>

            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteConfirm(null)} className="btn btn-secondary" disabled={loading}>
                {t('common.cancel')}
              </button>
              <button onClick={handleDeleteAccount} className="btn btn-error" disabled={loading}>
                {loading ? t('decks.deleting') : t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
