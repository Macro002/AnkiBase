import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, ExternalLink, Loader2, CheckCircle, AlertCircle, FileArchive, X, Link } from 'lucide-react';
import { importDeck, quizlet } from '../api';

interface ImportState {
  fileName: string;
  fileSize: number;
  startedAt: number;
  stage: 'uploading' | 'processing' | 'finalizing';
  progress: number;
}

function QuizletImport() {
  const [url, setUrl] = useState('');
  const [scraping, setScraping] = useState(false);
  const [preview, setPreview] = useState<{ title: string; cards: { front: string; back: string; image?: string | null }[] } | null>(null);
  const [deckName, setDeckName] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState('');

  const handleScrape = async () => {
    if (!url.trim()) return;
    setScraping(true);
    setError('');
    setPreview(null);
    setResult(null);
    try {
      const data = await quizlet.scrape(url.trim());
      setPreview(data);
      setDeckName(data.title);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch Quizlet deck');
    } finally {
      setScraping(false);
    }
  };

  const handleImport = async () => {
    if (!preview || !deckName.trim()) return;
    setImporting(true);
    setResult(null);
    try {
      await quizlet.saveDecks(deckName.trim(), url.trim(), preview.cards);
      setResult({ success: true, message: `Saved "${deckName}" (${preview.cards.length} cards) to Quizlet Decks` });
      setPreview(null);
      setUrl('');
    } catch (e) {
      setResult({ success: false, message: e instanceof Error ? e.message : 'Import failed' });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: '#4257b2' }}>
          <span className="text-white font-bold text-sm">Q</span>
        </div>
        <div>
          <h3 className="font-semibold">Import from Quizlet</h3>
          <p className="text-sm text-(--text-secondary)">Paste a Quizlet deck link to import cards directly</p>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          className="input flex-1"
          placeholder="https://quizlet.com/123456/deck-name/"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !scraping && handleScrape()}
          disabled={scraping}
        />
        <button
          className="btn btn-primary flex items-center gap-2 shrink-0"
          onClick={handleScrape}
          disabled={scraping || !url.trim()}
        >
          {scraping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link className="w-4 h-4" />}
          {scraping ? 'Fetching...' : 'Preview'}
        </button>
      </div>

      {scraping && (
        <p className="text-sm text-(--text-secondary) flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" />
          Loading deck — this takes ~10 seconds...
        </p>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-(--error)">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {preview && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-(--text-secondary)">{preview.cards.length} cards found</span>
          </div>

          <div>
            <label className="block text-sm text-(--text-secondary) mb-1">Deck name</label>
            <input
              className="input w-full"
              value={deckName}
              onChange={e => setDeckName(e.target.value)}
            />
          </div>

          <div className="rounded-lg border border-(--bg-tertiary) overflow-hidden">
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-(--bg-tertiary) text-(--text-secondary)">
                    {preview.cards.some(c => c.image) && <th className="px-3 py-2 text-left w-10">Img</th>}
                    <th className="px-3 py-2 text-left">Front</th>
                    <th className="px-3 py-2 text-left">Back</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.cards.map((card, i) => (
                    <tr key={i} className="border-t border-(--bg-tertiary)">
                      {preview.cards.some(c => c.image) && (
                        <td className="px-3 py-2">
                          {card.image ? (
                            <img src={card.image} alt="" className="w-8 h-8 object-cover rounded" />
                          ) : (
                            <span className="w-8 h-8 block" />
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2">{card.front}</td>
                      <td className="px-3 py-2 text-(--text-secondary)">{card.back}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <button
            className="btn btn-primary w-full flex items-center justify-center gap-2"
            onClick={handleImport}
            disabled={importing || !deckName.trim()}
          >
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {importing ? 'Saving...' : `Save ${preview.cards.length} cards to Quizlet Decks`}
          </button>
        </div>
      )}

      {result && (
        <div className={`flex items-center gap-2 text-sm p-3 rounded-lg ${result.success ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}`}>
          {result.success ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          {result.message}
        </div>
      )}
    </div>
  );
}

export function Import() {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [importStage, setImportStage] = useState<'uploading' | 'processing' | 'finalizing' | null>(null);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [restoredImport, setRestoredImport] = useState<ImportState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Restore import state from localStorage on mount
  useEffect(() => {
    const savedImport = localStorage.getItem('ankibase-import-state');
    if (savedImport) {
      try {
        const state: ImportState = JSON.parse(savedImport);
        // Only restore if import started within last 30 minutes
        const age = Date.now() - state.startedAt;
        if (age < 30 * 60 * 1000) {
          setRestoredImport(state);
        } else {
          // Clear old import state
          localStorage.removeItem('ankibase-import-state');
        }
      } catch (err) {
        console.error('Failed to restore import state:', err);
        localStorage.removeItem('ankibase-import-state');
      }
    }
  }, []);

  // Save import state to localStorage when it changes
  useEffect(() => {
    if (uploading && file) {
      const state: ImportState = {
        fileName: file.name,
        fileSize: file.size,
        startedAt: Date.now(),
        stage: importStage || 'uploading',
        progress: uploadProgress,
      };
      localStorage.setItem('ankibase-import-state', JSON.stringify(state));
    }
  }, [uploading, file, importStage, uploadProgress]);

  const clearImportState = () => {
    localStorage.removeItem('ankibase-import-state');
    setRestoredImport(null);
  };

  const handleFileSelect = (selectedFile: File | null) => {
    if (selectedFile && selectedFile.name.endsWith('.apkg')) {
      setFile(selectedFile);
      setResult(null);
    } else if (selectedFile) {
      setResult({ success: false, message: t('import.onlyApkg', 'Only .apkg files are supported') });
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    handleFileSelect(droppedFile);
  };

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    setResult(null);
    setUploadProgress(0);
    setImportStage('uploading');

    try {
      const res = await importDeck.upload(file, (progress) => {
        setUploadProgress(progress);
        if (progress === 100) {
          // Once upload completes, show processing stage
          setImportStage('processing');
        }
      });

      // Show finalizing stage briefly
      setImportStage('finalizing');
      await new Promise(resolve => setTimeout(resolve, 500));

      setResult(res);
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      // Clear localStorage on success
      localStorage.removeItem('ankibase-import-state');
    } catch (err) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : 'Import failed',
      });
      // Clear localStorage on error
      localStorage.removeItem('ankibase-import-state');
    } finally {
      setUploading(false);
      setImportStage(null);
      setUploadProgress(0);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">{t('import.title')}</h2>

      <p className="text-(--text-secondary)">
        {t('import.description', 'Import Anki deck packages (.apkg files) to add new decks or merge cards into existing ones.')}
      </p>

      {/* Quizlet import */}
      <QuizletImport />

      {/* Restored import notice */}
      {restoredImport && !uploading && (
        <div className="card border-2 border-yellow-500/30 bg-yellow-500/10">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-yellow-400" />
              <h3 className="font-semibold text-yellow-400">{t('import.inProgress', 'Import in Progress')}</h3>
            </div>
            <button onClick={clearImportState} className="icon-btn">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-2 text-sm">
            <p><span className="font-medium">{t('import.file', 'File')}:</span> {restoredImport.fileName} ({(restoredImport.fileSize / 1024 / 1024).toFixed(2)} MB)</p>
            <p><span className="font-medium">{t('import.started', 'Started')}:</span> {new Date(restoredImport.startedAt).toLocaleTimeString()}</p>
            <p className="text-(--text-secondary) mt-3">
              {t('import.backgroundMessage', 'An import was in progress when you left this page. It may still be processing in the background. Check your Decks tab to see if the import has completed.')}
            </p>
          </div>
        </div>
      )}

      {/* Browse AnkiWeb link */}
      <div className="card">
        <h3 className="font-semibold mb-3">{t('import.browseDecks', 'Browse Shared Decks')}</h3>
        <p className="text-(--text-secondary) text-sm mb-4">
          {t('import.browseDescription', 'Find and download shared decks from AnkiWeb, then import them here.')}
        </p>
        <a
          href="https://ankiweb.net/shared/decks"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-secondary inline-flex items-center gap-2"
        >
          <ExternalLink className="w-4 h-4" />
          {t('import.browseAnkiWeb', 'Browse AnkiWeb Shared Decks')}
        </a>
      </div>

      {/* Upload area */}
      <div className="card">
        <h3 className="font-semibold mb-3">{t('import.uploadFile', 'Upload Deck File')}</h3>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !uploading && fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            uploading
              ? 'cursor-not-allowed opacity-50'
              : dragOver
              ? 'border-(--accent) bg-(--accent)/10 cursor-pointer'
              : 'border-(--bg-tertiary) hover-border-secondary cursor-pointer'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".apkg"
            onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
            className="hidden"
            disabled={uploading}
          />

          {file ? (
            <div className="flex flex-col items-center gap-2">
              <FileArchive className="w-12 h-12 text-(--accent)" />
              <p className="font-medium">{file.name}</p>
              <p className="text-sm text-(--text-secondary)">
                {(file.size / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Upload className="w-12 h-12 text-(--text-secondary)" />
              <p className="text-(--text-secondary)">
                {uploading ? t('import.importing') : t('import.dragDrop')}
              </p>
            </div>
          )}
        </div>

        {/* Upload button */}
        {file && !uploading && (
          <button
            onClick={handleUpload}
            className="btn btn-primary w-full mt-4 flex items-center justify-center gap-2"
          >
            <Upload className="w-5 h-5" />
            {t('import.importDeck')}
          </button>
        )}

        {/* Progress bar during upload */}
        {uploading && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {importStage === 'uploading' && t('import.uploading', 'Uploading...')}
                {importStage === 'processing' && t('import.processing', 'Processing import...')}
                {importStage === 'finalizing' && t('import.finalizing', 'Finalizing...')}
              </span>
              {importStage === 'uploading' && (
                <span className="text-(--text-secondary)">{uploadProgress}%</span>
              )}
            </div>

            {/* Progress bar */}
            <div className="w-full bg-(--bg-tertiary) rounded-full h-2 overflow-hidden">
              <div
                className="h-full bg-(--accent) transition-all duration-300"
                style={{
                  width: importStage === 'uploading'
                    ? `${uploadProgress}%`
                    : importStage === 'processing'
                    ? '100%'
                    : '100%'
                }}
              >
                {importStage !== 'uploading' && (
                  <div className="h-full w-full bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                )}
              </div>
            </div>

            {importStage === 'processing' && (
              <p className="text-xs text-(--text-secondary)">
                {t('import.processingMessage', 'This may take a few minutes for large decks. You can safely refresh or switch tabs - the import will continue in the background.')}
              </p>
            )}
          </div>
        )}

        {/* Result message */}
        {result && (
          <div
            className={`mt-4 p-4 rounded-lg flex items-center gap-3 ${
              result.success ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'
            }`}
          >
            {result.success ? (
              <CheckCircle className="w-5 h-5 shrink-0" />
            ) : (
              <AlertCircle className="w-5 h-5 shrink-0" />
            )}
            <span>{result.message}</span>
          </div>
        )}
      </div>

      {/* Instructions */}
      <div className="card">
        <h3 className="font-semibold mb-3">{t('import.howToImport', 'How to Import')}</h3>
        <ol className="list-decimal list-inside space-y-2 text-(--text-secondary) text-sm">
          <li>{t('import.step1', 'Visit AnkiWeb Shared Decks using the link above')}</li>
          <li>{t('import.step2', 'Search for a deck you want to study')}</li>
          <li>{t('import.step3', 'Click "Download" on the deck page to get the .apkg file')}</li>
          <li>{t('import.step4', 'Drag the downloaded file here or click to upload')}</li>
          <li>{t('import.step5', 'The deck will be imported and appear in your Decks tab')}</li>
        </ol>
      </div>

      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .animate-shimmer {
          animation: shimmer 1.5s infinite;
        }
      `}</style>
    </div>
  );
}
