import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { stats, type ReviewHistory } from '../api';

type ColorScheme = 'accent' | 'green';

interface HeatmapProps {
  className?: string;
}

type Source = 'all' | 'anki' | 'quizlet';

export function Heatmap({ className = '' }: HeatmapProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<ReviewHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState(new Date().getFullYear());
  const [hoveredDay, setHoveredDay] = useState<{ date: string; count: number } | null>(null);
  const [source, setSource] = useState<Source>('all');
  const [slideDir, setSlideDir] = useState<'left' | 'right' | null>(null);
  const [colorScheme, setColorScheme] = useState<ColorScheme>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('heatmap-color') as ColorScheme) || 'accent';
    }
    return 'accent';
  });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const result = await stats.getReviewHistory(undefined, source);
        setData(result);
      } catch (err) {
        console.error('Failed to load review history:', err);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [source]);

  useEffect(() => {
    localStorage.setItem('heatmap-color', colorScheme);
  }, [colorScheme]);

  const currentYear = new Date().getFullYear();

  const handlePrevYear = () => { setSlideDir('left'); setYear(y => y - 1); };
  const handleNextYear = () => { setSlideDir('right'); setYear(y => Math.min(y + 1, currentYear)); };
  const handleResetYear = () => { if (year !== currentYear) { setSlideDir('right'); setYear(currentYear); } };

  const buildWeeksForYear = (targetYear: number) => {
    const startDate = new Date(targetYear, 0, 1);
    const endDate = new Date(targetYear, 11, 31);

    let dayOfWeek = startDate.getDay();
    dayOfWeek = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    startDate.setDate(startDate.getDate() - dayOfWeek);

    const weeks: { date: Date; count: number; isCurrentYear: boolean }[][] = [];
    const monthLabels: { month: string; weekIndex: number }[] = [];
    let currentWeek: { date: Date; count: number; isCurrentYear: boolean }[] = [];
    let lastMonth = -1;

    const current = new Date(startDate);
    let weekIndex = 0;

    while (current <= endDate || currentWeek.length > 0) {
      const dateStr = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
      const count = data?.daily_counts[dateStr] || 0;
      const isCurrentYear = current.getFullYear() === targetYear;

      currentWeek.push({ date: new Date(current), count, isCurrentYear });

      if (current.getMonth() !== lastMonth && isCurrentYear) {
        const dayInWeek = currentWeek.length - 1;
        if (dayInWeek === 0 || (weekIndex === 0 && current.getMonth() === 0)) {
          const monthIndex = current.getMonth();
          const monthName = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][monthIndex];
          monthLabels.push({ month: monthName, weekIndex });
          lastMonth = current.getMonth();
        } else if (current.getDate() <= 7) {
          const monthIndex = current.getMonth();
          const monthName = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][monthIndex];
          if (!monthLabels.some(m => m.month === monthName && m.weekIndex === weekIndex)) {
            monthLabels.push({ month: monthName, weekIndex });
            lastMonth = current.getMonth();
          }
        }
      }

      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
        weekIndex++;
      }

      current.setDate(current.getDate() + 1);

      if (current > endDate && currentWeek.length === 0) break;
    }

    if (currentWeek.length > 0) {
      weeks.push(currentWeek);
    }

    return { weeks, monthLabels };
  };

  const yearData = useMemo(() => buildWeeksForYear(year), [year, data]);

  const getColorStyle = (count: number, isCurrentYear: boolean): React.CSSProperties => {
    if (!isCurrentYear) return { backgroundColor: 'rgba(15, 52, 96, 0.3)' };
    if (count === 0) return { backgroundColor: 'var(--bg-tertiary)' };

    if (colorScheme === 'accent') {
      if (count < 10) return { backgroundColor: 'rgba(var(--accent-rgb), 0.25)' };
      if (count < 25) return { backgroundColor: 'rgba(var(--accent-rgb), 0.45)' };
      if (count < 50) return { backgroundColor: 'rgba(var(--accent-rgb), 0.65)' };
      if (count < 100) return { backgroundColor: 'rgba(var(--accent-rgb), 0.85)' };
      return { backgroundColor: 'var(--accent)' };
    } else {
      if (count < 10) return { backgroundColor: '#14532d' };
      if (count < 25) return { backgroundColor: '#166534' };
      if (count < 50) return { backgroundColor: '#22c55e' };
      if (count < 100) return { backgroundColor: '#4ade80' };
      return { backgroundColor: '#86efac' };
    }
  };

  const todayStr = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }, []);

  const accentColor = colorScheme === 'accent' ? 'var(--accent)' : '#4ade80';

  const statsData = useMemo(() => {
    if (!data) return { totalReviews: 0, daysStudied: 0, dailyAverage: 0, daysLearnedPercent: 0, longestStreak: 0, currentStreak: 0 };

    const yearEntries = Object.entries(data.daily_counts)
      .filter(([date]) => date.startsWith(String(year)))
      .sort(([a], [b]) => a.localeCompare(b));

    const totalReviews = yearEntries.reduce((sum, [, count]) => sum + count, 0);
    const daysStudied = yearEntries.filter(([, count]) => count > 0).length;

    const now = new Date();
    const startOfYear = new Date(year, 0, 1);
    const endOfYear = new Date(year, 11, 31);
    const referenceDate = year === currentYear ? now : endOfYear;
    const daysInYear = Math.ceil((referenceDate.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)) + 1;

    const dailyAverage = daysInYear > 0 ? Math.round(totalReviews / daysInYear) : 0;
    const daysLearnedPercent = daysInYear > 0 ? Math.round((daysStudied / daysInYear) * 100) : 0;

    const allDates = Object.entries(data.daily_counts)
      .filter(([, count]) => count > 0)
      .map(([date]) => date)
      .sort();

    let longestStreak = 0;
    let currentStreak = 0;
    let tempStreak = 0;
    let prevDate: Date | null = null;

    for (const dateStr of allDates) {
      const [y, m, d] = dateStr.split('-').map(Number);
      const date = new Date(y, m - 1, d);

      if (prevDate) {
        const diffDays = Math.round((date.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          tempStreak++;
        } else {
          longestStreak = Math.max(longestStreak, tempStreak);
          tempStreak = 1;
        }
      } else {
        tempStreak = 1;
      }
      prevDate = date;
    }
    longestStreak = Math.max(longestStreak, tempStreak);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    if (data.daily_counts[todayKey] > 0 || data.daily_counts[yesterdayKey] > 0) {
      let checkDate = data.daily_counts[todayKey] > 0 ? new Date(today) : new Date(yesterday);
      currentStreak = 0;

      while (true) {
        const key = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
        if (data.daily_counts[key] > 0) {
          currentStreak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    }

    return { totalReviews, daysStudied, dailyAverage, daysLearnedPercent, longestStreak, currentStreak };
  }, [data, year, currentYear]);

  if (loading) {
    return (
      <div className={`card ${className}`}>
        {/* Header skeleton */}
        <div className="flex items-center justify-between mb-4">
          <div className="skeleton h-6 w-32"></div>
          <div className="flex items-center gap-2">
            <div className="skeleton h-9 w-9 rounded"></div>
            <div className="skeleton h-9 w-16 rounded"></div>
            <div className="skeleton h-9 w-9 rounded"></div>
          </div>
        </div>

        {/* Tooltip skeleton */}
        <div className="mb-3 h-5">
          <div className="skeleton h-4 w-48"></div>
        </div>

        {/* Heatmap grid skeleton */}
        <div className="flex gap-1 mb-3">
          {/* Month labels skeleton */}
          <div className="flex flex-col justify-end mr-1">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="skeleton h-4 w-8 mb-1"></div>
            ))}
          </div>

          {/* Weeks skeleton */}
          <div className="flex gap-1 overflow-x-auto">
            {Array.from({ length: 53 }).map((_, weekIdx) => (
              <div key={weekIdx} className="flex flex-col gap-1">
                {Array.from({ length: 7 }).map((_, dayIdx) => (
                  <div key={dayIdx} className="skeleton w-4 h-4 rounded-sm"></div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Legend skeleton */}
        <div className="flex items-center justify-end gap-1.5 text-xs">
          <div className="skeleton h-3 w-12"></div>
          <div className="flex gap-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton w-4 h-4 rounded-sm"></div>
            ))}
          </div>
          <div className="skeleton h-3 w-12"></div>
        </div>
      </div>
    );
  }

  const dayLabels = [
    t('heatmap.mon'),
    t('heatmap.tue'),
    t('heatmap.wed'),
    t('heatmap.thu'),
    t('heatmap.fri'),
    t('heatmap.sat'),
    t('heatmap.sun')
  ];
  const squareSize = 16;
  const gap = 3;

  return (
    <div className={`card ${className}`}>
      {/* Header with year navigation */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">{t('heatmap.activityHeatmap')}</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={handlePrevYear}
            className="p-1.5 hover-bg-tertiary rounded transition-colors"
            title={t('heatmap.previousYear', 'Previous year')}
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={handleResetYear}
            disabled={year === currentYear}
            className="px-3 py-1.5 text-sm font-medium min-w-[60px] text-center rounded hover-bg-tertiary transition-colors disabled:opacity-50 disabled:cursor-default"
            title={year !== currentYear ? 'Return to current year' : undefined}
          >
            {year}
          </button>
          <button
            onClick={handleNextYear}
            disabled={year >= currentYear}
            className="p-1.5 hover-bg-tertiary rounded transition-colors disabled:opacity-30"
            title={t('heatmap.nextYear', 'Next year')}
          >
            <ChevronRight className="w-5 h-5" />
          </button>
          <select
            className="input text-sm py-1 px-2 ml-1"
            value={source}
            onChange={e => setSource(e.target.value as Source)}
          >
            <option value="all">All</option>
            <option value="anki">Anki</option>
            <option value="quizlet">Quizlet</option>
          </select>
        </div>
      </div>

      {/* Tooltip */}
      <div className="mb-3 text-sm text-(--text-secondary) h-5">
        {hoveredDay ? (
          <>
            <span className="font-medium" style={{ color: accentColor }}>{hoveredDay.count} {t('heatmap.cards', 'cards')}</span> {t('heatmap.reviewedOn', 'reviewed on')}{' '}
            {(() => {
              const [y, m, d] = hoveredDay.date.split('-').map(Number);
              return new Date(y, m - 1, d).toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              });
            })()}
          </>
        ) : (
          t('heatmap.hoverHint', 'Hover over a day to see details')
        )}
      </div>

      {/* Heatmap grid */}
      <div
        key={year}
        ref={containerRef}
        className={slideDir === 'right' ? 'slide-in-right' : slideDir === 'left' ? 'slide-in-left' : ''}
        onAnimationEnd={() => setSlideDir(null)}
      >
        {/* Grid with day labels */}
        <div className="flex">
          {/* Day labels column */}
          <div className="flex flex-col text-xs text-(--text-secondary) mr-2 shrink-0" style={{ gap: `${gap}px`, marginTop: '20px' }}>
            {dayLabels.map((day, i) => (
              <div key={i} className="flex items-center justify-end w-10" style={{ height: `${squareSize}px` }}>
                {day}
              </div>
            ))}
          </div>

          {/* Scrollable container for months and weeks */}
          <div className="overflow-x-auto pb-2">
            {/* Month labels row */}
            <div className="flex relative mb-1" style={{ height: '20px' }}>
              {yearData.monthLabels.map(({ month, weekIndex }, i) => (
                <span
                  key={i}
                  className="absolute text-xs text-(--text-secondary)"
                  style={{ left: `${weekIndex * (squareSize + gap)}px` }}
                >
                  {t(`heatmap.${month}`)}
                </span>
              ))}
            </div>

            {/* Weeks grid */}
            <div className="flex" style={{ gap: `${gap}px` }}>
              {yearData.weeks.map((week, weekIndex) => (
                <div key={weekIndex} className="flex flex-col" style={{ gap: `${gap}px` }}>
                  {week.map((day, dayIndex) => {
                    const dateStr = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}-${String(day.date.getDate()).padStart(2, '0')}`;
                    const isToday = dateStr === todayStr && year === currentYear;
                    const isHovered = hoveredDay?.date === dateStr;
                    return (
                      <div
                        key={dayIndex}
                        className={`rounded-sm cursor-pointer transition-all duration-150 ${
                          isToday ? 'ring-2 ring-white ring-offset-1 ring-offset-(--bg-secondary)' : ''
                        } ${isHovered ? 'scale-125 z-10' : 'hover:scale-110'}`}
                        style={{
                          width: `${squareSize}px`,
                          height: `${squareSize}px`,
                          ...getColorStyle(day.count, day.isCurrentYear)
                        }}
                        onMouseEnter={() => day.isCurrentYear && setHoveredDay({ date: dateStr, count: day.count })}
                        onMouseLeave={() => setHoveredDay(null)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mt-4 text-sm text-(--text-secondary)">
        <span>{t('heatmap.dailyAverage')}: <span className="font-medium" style={{ color: accentColor }}>{statsData.dailyAverage} {t('heatmap.cards')}</span></span>
        <span>{t('heatmap.daysLearned')}: <span className="font-medium" style={{ color: accentColor }}>{statsData.daysLearnedPercent}%</span></span>
        <span>{t('heatmap.longestStreak')}: <span className="font-medium" style={{ color: accentColor }}>{statsData.longestStreak} {t('heatmap.days')}</span></span>
        <span>{t('heatmap.currentStreak')}: <span className="font-medium" style={{ color: accentColor }}>{statsData.currentStreak} {statsData.currentStreak === 1 ? t('heatmap.day') : t('heatmap.days')}</span></span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center justify-end mt-3 gap-2 text-xs text-(--text-secondary)">
        <span>{t('heatmap.less')}</span>
        {colorScheme === 'accent' ? (
          <>
            <div className="rounded-sm" style={{ width: `${squareSize}px`, height: `${squareSize}px`, backgroundColor: 'var(--bg-tertiary)' }}></div>
            <div className="rounded-sm" style={{ width: `${squareSize}px`, height: `${squareSize}px`, backgroundColor: 'rgba(var(--accent-rgb), 0.25)' }}></div>
            <div className="rounded-sm" style={{ width: `${squareSize}px`, height: `${squareSize}px`, backgroundColor: 'rgba(var(--accent-rgb), 0.45)' }}></div>
            <div className="rounded-sm" style={{ width: `${squareSize}px`, height: `${squareSize}px`, backgroundColor: 'rgba(var(--accent-rgb), 0.65)' }}></div>
            <div className="rounded-sm" style={{ width: `${squareSize}px`, height: `${squareSize}px`, backgroundColor: 'rgba(var(--accent-rgb), 0.85)' }}></div>
            <div className="rounded-sm" style={{ width: `${squareSize}px`, height: `${squareSize}px`, backgroundColor: 'var(--accent)' }}></div>
          </>
        ) : (
          <>
            <div className="rounded-sm bg-(--bg-tertiary)" style={{ width: `${squareSize}px`, height: `${squareSize}px` }}></div>
            <div className="rounded-sm" style={{ width: `${squareSize}px`, height: `${squareSize}px`, backgroundColor: '#14532d' }}></div>
            <div className="rounded-sm" style={{ width: `${squareSize}px`, height: `${squareSize}px`, backgroundColor: '#166534' }}></div>
            <div className="rounded-sm" style={{ width: `${squareSize}px`, height: `${squareSize}px`, backgroundColor: '#22c55e' }}></div>
            <div className="rounded-sm" style={{ width: `${squareSize}px`, height: `${squareSize}px`, backgroundColor: '#4ade80' }}></div>
            <div className="rounded-sm" style={{ width: `${squareSize}px`, height: `${squareSize}px`, backgroundColor: '#86efac' }}></div>
          </>
        )}
        <span>{t('heatmap.more')}</span>

        {/* Toggle button */}
        <button
          onClick={() => setColorScheme(colorScheme === 'accent' ? 'green' : 'accent')}
          className="ml-2 px-2 py-1 rounded text-xs bg-(--bg-tertiary) hover-bg-primary transition-colors"
          title={`${t('heatmap.switchTo', 'Switch to')} ${colorScheme === 'accent' ? t('heatmap.green', 'green') : t('heatmap.accent', 'accent')}`}
        >
          {colorScheme === 'accent' ? t('heatmap.accentColor', 'Accent') : t('heatmap.greenColor', 'Green')}
        </button>
      </div>
    </div>
  );
}
