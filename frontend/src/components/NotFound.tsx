import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Home } from 'lucide-react';

export function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card max-w-md text-center space-y-4">
        <div className="text-6xl font-bold text-(--accent)">404</div>
        <h1 className="text-2xl font-bold">{t('notFound.title')}</h1>
        <p className="text-(--text-secondary)">
          {t('notFound.description')}
        </p>
        <Link to="/" className="btn btn-primary inline-flex items-center gap-2">
          <Home className="w-4 h-4" />
          {t('notFound.goHome')}
        </Link>
      </div>
    </div>
  );
}
