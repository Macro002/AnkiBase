import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '../quizlet/ui';
import { reminderSettings, setReminders, type ReminderSettings } from '../../native';

const pad = (n: number) => String(n).padStart(2, '0');

/** Settings → Reminders (iPhone): a daily notification naming the decks that are behind,
 *  and the app icon's badge with how many there are (ios/Sources/AnkiBase/Reminders.swift). */
export function RemindersSection() {
  const { t } = useTranslation();
  const [value, setValue] = useState<ReminderSettings>(reminderSettings() ?? { enabled: false, hour: 9, minute: 0 });
  const [busy, setBusy] = useState(false);

  const save = async (next: { enabled: boolean; hour: number; minute: number }) => {
    setBusy(true);
    setValue({ ...next, denied: false });
    const strings = {
      title: t('reminders.notification.title'),
      one: t('reminders.notification.one'),
      other: t('reminders.notification.other'),
      and: t('reminders.notification.and'),
      more: t('reminders.notification.more'),
    };
    try { setValue(await setReminders(next, strings)); } finally { setBusy(false); }
  };

  const onTime = (text: string) => {
    const [hour, minute] = text.split(':').map(Number);
    if (Number.isInteger(hour) && Number.isInteger(minute)) save({ enabled: value.enabled, hour, minute });
  };

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-semibold">{t('reminders.title')}</h3>
          <p className="text-xs text-(--text-secondary) mt-0.5">{t('reminders.description')}</p>
        </div>
        <Toggle on={value.enabled} disabled={busy}
          onChange={enabled => save({ enabled, hour: value.hour, minute: value.minute })} />
      </div>

      {value.enabled && (
        <label className="flex items-center justify-between gap-4 rounded-xl bg-(--bg-tertiary)/60 px-4 py-3 anim-rise">
          <span className="text-sm">{t('reminders.time')}</span>
          <input type="time" value={`${pad(value.hour)}:${pad(value.minute)}`} disabled={busy}
            onChange={e => onTime(e.target.value)}
            className="bg-transparent text-sm font-medium text-right" />
        </label>
      )}

      {value.denied && <p className="text-sm text-(--error) anim-rise">{t('reminders.denied')}</p>}
    </section>
  );
}
