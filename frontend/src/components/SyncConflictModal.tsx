import { Download, Upload, X, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sync } from '../api';

interface SyncConflictModalProps {
  isOpen: boolean;
  onClose: () => void;
  onResolved: () => void;
}

export function SyncConflictModal({ isOpen, onClose, onResolved }: SyncConflictModalProps) {
  const { t } = useTranslation();
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleFullUpload = async () => {
    setResolving(true);
    setError('');
    try {
      await sync.fullUpload();
      onResolved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setResolving(false);
    }
  };

  const handleFullDownload = async () => {
    setResolving(true);
    setError('');
    try {
      await sync.fullDownload();
      onResolved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-(--bg-secondary) rounded-lg shadow-xl max-w-lg w-full border border-(--bg-tertiary)">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-(--bg-tertiary)">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-6 h-6 text-orange-400" />
            <h2 className="text-xl font-bold">{t('syncConflict.title')}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={resolving}
            className="icon-btn disabled-opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          <p className="text-(--text-secondary)">
            {t('syncConflict.description')}
          </p>

          <div className="space-y-3">
            {/* Upload option */}
            <button
              onClick={handleFullUpload}
              disabled={resolving}
              className="btn btn-primary w-full flex items-center gap-3 justify-start"
            >
              <Upload className="w-5 h-5" />
              <div className="text-left">
                <div className="font-semibold">{t('syncConflict.uploadLocal')}</div>
                <div className="text-xs opacity-80 font-normal">
                  {t('syncConflict.uploadLocalDesc')}
                </div>
              </div>
            </button>

            {/* Download option */}
            <button
              onClick={handleFullDownload}
              disabled={resolving}
              className="btn btn-secondary w-full flex items-center gap-3 justify-start"
            >
              <Download className="w-5 h-5" />
              <div className="text-left">
                <div className="font-semibold">{t('syncConflict.downloadRemote')}</div>
                <div className="text-xs opacity-80 font-normal">
                  {t('syncConflict.downloadRemoteDesc')}
                </div>
              </div>
            </button>
          </div>

          {resolving && (
            <div className="text-center text-sm text-(--text-secondary)">
              {resolving ? t('syncConflict.uploading') : t('syncConflict.downloading')}
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-400/10 text-red-400 rounded-lg text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 pt-0">
          <button
            onClick={onClose}
            disabled={resolving}
            className="btn btn-secondary w-full"
          >
            {t('syncConflict.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
