import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Clock, TrendingUp } from 'lucide-react';
import { stats, decks } from '../api';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface DailyReviewData {
  date: string;
  count: number;
  time: number;
}

const BUTTON_COLORS = {
  1: '#ef4444', // Again - red
  2: '#f97316', // Hard - orange
  3: '#22c55e', // Good - green
  4: '#3b82f6', // Easy - blue
};

export function Stats() {
  const { t } = useTranslation();
  const [deckList, setDeckList] = useState<Record<string, number>>({});
  const [selectedDeck, setSelectedDeck] = useState<string>('');
  const [reviewData, setReviewData] = useState<DailyReviewData[]>([]);
  const [todayCount, setTodayCount] = useState(0);
  const [todayTime, setTodayTime] = useState(0);
  const [hourlyData, setHourlyData] = useState<any[]>([]);
  const [buttonData, setButtonData] = useState<any[]>([]);
  const [intervalData, setIntervalData] = useState<any[]>([]);
  const [deckStats, setDeckStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState<'7d' | '30d' | '90d' | 'all'>('30d');

  // Load deck list on mount
  useEffect(() => {
    const loadDecks = async () => {
      try {
        const deckData = await decks.list();
        setDeckList(deckData.decks);
        // Set first deck as default (not "All Decks")
        const firstDeck = Object.keys(deckData.decks)[0];
        if (firstDeck) {
          setSelectedDeck(firstDeck);
        }
      } catch (err) {
        console.error('Failed to load decks:', err);
      }
    };
    loadDecks();
  }, []);

  const loadStats = async () => {
    if (!selectedDeck) return;

    setLoading(true);
    setError(null);
    try {
      // Fetch review history for selected deck
      const reviewHistory = await stats.getReviewHistory(selectedDeck === 'All Decks' ? '' : selectedDeck);
      setTodayCount(reviewHistory.today);
      setTodayTime(reviewHistory.today_time_seconds);

      // Convert to array and sort by date
      const dataArray = Object.entries(reviewHistory.daily_counts)
        .map(([date, count]) => ({
          date,
          count: count as number,
          time: (reviewHistory.daily_time[date] || 0) as number,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      setReviewData(dataArray);

      // Hourly breakdown
      const hourlyArray = Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        count: (reviewHistory.hourly_counts[i.toString()] || 0) as number,
      }));
      setHourlyData(hourlyArray);

      // Answer buttons
      const buttonLabels: Record<number, string> = {
        1: t('study.again'),
        2: t('study.hard'),
        3: t('study.good'),
        4: t('study.easy'),
      };
      const buttonArray = [1, 2, 3, 4].map((btn) => ({
        name: buttonLabels[btn],
        value: (reviewHistory.button_counts[btn.toString()] || 0) as number,
        fill: BUTTON_COLORS[btn as keyof typeof BUTTON_COLORS],
      }));
      setButtonData(buttonArray);

      // Intervals
      const intervalOrder = ['< 1 day', '1-6 days', '1-4 weeks', '1-6 months', '6+ months'];
      const intervalArray = intervalOrder.map((range) => ({
        range,
        count: (reviewHistory.interval_ranges[range] || 0) as number,
      }));
      setIntervalData(intervalArray);

      // Fetch deck stats
      const deckData = await decks.list();
      setDeckStats(deckData.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  };

  // Load stats when deck changes
  useEffect(() => {
    if (selectedDeck) {
      loadStats();
    }
  }, [selectedDeck]);

  // Filter data based on selected range
  const getFilteredData = () => {
    if (selectedRange === 'all') return reviewData;

    const now = new Date();
    const days = selectedRange === '7d' ? 7 : selectedRange === '30d' ? 30 : 90;
    const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    return reviewData.filter((d) => d.date >= cutoffStr);
  };

  const filteredData = getFilteredData();

  // Calculate stats
  const totalReviews = filteredData.reduce((sum, d) => sum + d.count, 0);
  const totalTime = filteredData.reduce((sum, d) => sum + d.time, 0);
  const avgReviews = filteredData.length > 0 ? (totalReviews / filteredData.length).toFixed(1) : '0';
  const avgTime = totalReviews > 0 ? (totalTime / totalReviews).toFixed(1) : '0';
  const maxReviews = filteredData.length > 0 ? Math.max(...filteredData.map((d) => d.count)) : 0;

  // Get current deck stats
  const currentDeckStats =
    selectedDeck && selectedDeck !== 'All Decks' && deckStats ? deckStats[selectedDeck] : null;

  // Format time helper
  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  const deckOptions = ['All Decks', ...Object.keys(deckList)];

  return (
    <div className="space-y-6">
      {/* Header with Deck Selector */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        {/* Deck Selector */}
        <select
          value={selectedDeck}
          onChange={(e) => setSelectedDeck(e.target.value)}
          className="input text-sm min-w-[200px]"
        >
          {deckOptions.map((deck) => (
            <option key={deck} value={deck}>
              {deck}
            </option>
          ))}
        </select>
        <button onClick={loadStats} disabled={loading} className="btn btn-secondary flex items-center gap-2">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {t('common.refresh', 'Refresh')}
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400">{error}</div>
      )}

      {/* Loading state */}
      {loading ? (
        <div className="card flex items-center justify-center py-20">
          <RefreshCw className="w-8 h-8 animate-spin text-(--text-secondary)" />
        </div>
      ) : (
        <>
          {/* Today Section */}
          <div className="card">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <Clock className="w-5 h-5 text-(--accent)" />
              {t('stats.today', 'Today')}
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <div className="text-sm text-(--text-secondary)">{t('stats.cardsStudied', 'Cards Studied')}</div>
                <div className="text-3xl font-bold text-(--accent) mt-1">{todayCount}</div>
              </div>
              <div>
                <div className="text-sm text-(--text-secondary)">{t('stats.studyTime', 'Study Time')}</div>
                <div className="text-3xl font-bold text-(--accent) mt-1">{formatTime(todayTime)}</div>
              </div>
              <div>
                <div className="text-sm text-(--text-secondary)">{t('stats.avgPerCard', 'Avg per Card')}</div>
                <div className="text-3xl font-bold text-(--accent) mt-1">
                  {todayCount > 0 ? formatTime(todayTime / todayCount) : '0s'}
                </div>
              </div>
              <div>
                <div className="text-sm text-(--text-secondary)">{t('stats.againRate', 'Again Rate')}</div>
                <div className="text-3xl font-bold text-(--accent) mt-1">
                  {buttonData.length > 0 && buttonData[0].value > 0
                    ? ((buttonData[0].value / buttonData.reduce((s, b) => s + b.value, 0)) * 100).toFixed(0)
                    : '0'}
                  %
                </div>
              </div>
            </div>
          </div>

          {/* Forecast */}
          {currentDeckStats && (
            <div className="card">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-(--accent)" />
                {t('stats.forecast', 'Forecast')}
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <div className="text-sm text-(--text-secondary)">{t('decks.newCards')}</div>
                  <div className="text-2xl font-bold text-blue-400 mt-1">{currentDeckStats.new_count || 0}</div>
                </div>
                <div>
                  <div className="text-sm text-(--text-secondary)">{t('decks.learning')}</div>
                  <div className="text-2xl font-bold text-yellow-400 mt-1">
                    {currentDeckStats.learn_count || 0}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-(--text-secondary)">{t('stats.toReview', 'To Review')}</div>
                  <div className="text-2xl font-bold text-green-400 mt-1">
                    {currentDeckStats.review_count || 0}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-(--text-secondary)">{t('stats.totalInDeck', 'Total in Deck')}</div>
                  <div className="text-2xl font-bold text-(--accent) mt-1">
                    {currentDeckStats.total_in_deck || 0}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Summary Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="card">
              <div className="text-sm text-(--text-secondary)">Average ({selectedRange})</div>
              <div className="text-3xl font-bold text-(--accent) mt-1">{avgReviews}</div>
              <div className="text-xs text-(--text-secondary) mt-1">reviews/day</div>
            </div>
            <div className="card">
              <div className="text-sm text-(--text-secondary)">Total ({selectedRange})</div>
              <div className="text-3xl font-bold text-(--accent) mt-1">{totalReviews}</div>
              <div className="text-xs text-(--text-secondary) mt-1">reviews</div>
            </div>
            <div className="card">
              <div className="text-sm text-(--text-secondary)">Peak Day</div>
              <div className="text-3xl font-bold text-(--accent) mt-1">{maxReviews}</div>
              <div className="text-xs text-(--text-secondary) mt-1">reviews</div>
            </div>
            <div className="card">
              <div className="text-sm text-(--text-secondary)">Avg Time/Card</div>
              <div className="text-3xl font-bold text-(--accent) mt-1">{avgTime}s</div>
              <div className="text-xs text-(--text-secondary) mt-1">per review</div>
            </div>
          </div>

          {/* Time Range Selector */}
          <div className="flex gap-2">
            {(['7d', '30d', '90d', 'all'] as const).map((range) => (
              <button
                key={range}
                onClick={() => setSelectedRange(range)}
                className={`px-3 py-1.5 rounded text-sm transition-colors ${
                  selectedRange === range
                    ? 'bg-(--accent) text-white'
                    : 'bg-(--bg-tertiary) text-(--text-secondary) hover-bg-primary'
                }`}
              >
                {range === 'all' ? t('stats.allTime', 'All Time') : range.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Review Count Chart */}
          <div className="card">
            <h2 className="text-lg font-semibold mb-4">{t('stats.reviewCount', 'Review Count')}</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={filteredData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
                <XAxis
                  dataKey="date"
                  stroke="#aaa"
                  tick={{ fill: '#aaa', fontSize: 12 }}
                  tickFormatter={(date) => {
                    const d = new Date(date);
                    return `${d.getMonth() + 1}/${d.getDate()}`;
                  }}
                />
                <YAxis stroke="#aaa" tick={{ fill: '#aaa', fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#16213e',
                    border: '1px solid #0f3460',
                    borderRadius: '0.5rem',
                    color: '#eee',
                  }}
                  labelStyle={{ color: '#e94560' }}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#e94560"
                  strokeWidth={2}
                  dot={{ fill: '#e94560', r: 3 }}
                  activeDot={{ r: 5 }}
                  name="Reviews"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Review Time Chart */}
          <div className="card">
            <h2 className="text-lg font-semibold mb-4">{t('stats.reviewTime', 'Review Time (minutes)')}</h2>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={filteredData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
                <XAxis
                  dataKey="date"
                  stroke="#aaa"
                  tick={{ fill: '#aaa', fontSize: 12 }}
                  tickFormatter={(date) => {
                    const d = new Date(date);
                    return `${d.getMonth() + 1}/${d.getDate()}`;
                  }}
                />
                <YAxis stroke="#aaa" tick={{ fill: '#aaa', fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#16213e',
                    border: '1px solid #0f3460',
                    borderRadius: '0.5rem',
                    color: '#eee',
                  }}
                  labelStyle={{ color: '#e94560' }}
                  formatter={(value) => `${((value as number) / 60).toFixed(1)} min`}
                />
                <Bar dataKey="time" fill="#3b82f6" name="Time (seconds)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Answer Buttons */}
            <div className="card">
              <h2 className="text-lg font-semibold mb-4">{t('stats.answerButtons', 'Answer Buttons')}</h2>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={buttonData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    label={({ name, percent }) =>
                      `${name} ${percent ? (percent * 100).toFixed(0) : '0'}%`
                    }
                  >
                    {buttonData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#16213e',
                      border: '1px solid #0f3460',
                      borderRadius: '0.5rem',
                      color: '#eee',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Intervals */}
            <div className="card">
              <h2 className="text-lg font-semibold mb-4">{t('stats.cardIntervals', 'Card Intervals')}</h2>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={intervalData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
                  <XAxis dataKey="range" stroke="#aaa" tick={{ fill: '#aaa', fontSize: 11 }} angle={-15} textAnchor="end" height={80} />
                  <YAxis stroke="#aaa" tick={{ fill: '#aaa', fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#16213e',
                      border: '1px solid #0f3460',
                      borderRadius: '0.5rem',
                      color: '#eee',
                    }}
                  />
                  <Bar dataKey="count" fill="#e94560" name="Cards" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Hourly Breakdown */}
          <div className="card">
            <h2 className="text-lg font-semibold mb-4">{t('stats.hourlyBreakdown', 'Hourly Breakdown')}</h2>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={hourlyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
                <XAxis dataKey="hour" stroke="#aaa" tick={{ fill: '#aaa', fontSize: 12 }} />
                <YAxis stroke="#aaa" tick={{ fill: '#aaa', fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#16213e',
                    border: '1px solid #0f3460',
                    borderRadius: '0.5rem',
                    color: '#eee',
                  }}
                  labelFormatter={(hour) => `${hour}:00`}
                />
                <Bar dataKey="count" fill="#22c55e" name="Reviews" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
