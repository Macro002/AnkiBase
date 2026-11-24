import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '../quizlet/ui';
import { keepAudioAwakeEnabled, setKeepAudioAwake } from '../../audioKeeper';

/** Settings → Studying: options for this device while reviewing cards. */
export function StudyingSection() {
  const { t } = useTranslation();
  const [awake, setAwake] = useState(keepAudioAwakeEnabled);

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-semibold">{t('studying.keepAudioAwake.title')}</h3>
          <p className="text-xs text-(--text-secondary) mt-0.5">{t('studying.keepAudioAwake.description')}</p>
        </div>
        <Toggle on={awake} onChange={on => { setKeepAudioAwake(on); setAwake(on); }} />
      </div>
    </section>
  );
}
