//! The Stats tab's Anki numbers, from Anki's own statistics (the Statistics screen's data).

use std::collections::BTreeMap;

use anki::services::StatsService;
use anki_proto::stats::graphs_response::{buttons::ButtonCounts, hours::Hour, true_retention_stats::TrueRetention};
use anki_proto::stats::{GraphsRequest, GraphsResponse};
use chrono::{Duration, Local, NaiveDate};
use serde_json::{json, Map, Value};

use crate::engine::{Engine, Failure, Outcome};

pub fn period_days(period: &str) -> Option<Option<i32>> {
    match period {
        "1m" => Some(Some(30)),
        "3m" => Some(Some(91)),
        "1y" => Some(Some(365)),
        "all" => Some(None),
        _ => None,
    }
}

/// Anki's "today": the date that started at the last day rollover (4am by default).
fn today(rollover_hour: u32) -> NaiveDate {
    (Local::now() - Duration::hours(rollover_hour as i64)).date_naive()
}

fn date(today: NaiveDate, offset: i32) -> String {
    (today + Duration::days(offset as i64)).format("%Y-%m-%d").to_string()
}

fn retention(cell: Option<&TrueRetention>) -> Value {
    let cell = cell.cloned().unwrap_or_default();
    json!({"young_pass": cell.young_passed, "young_fail": cell.young_failed,
           "mature_pass": cell.mature_passed, "mature_fail": cell.mature_failed})
}

fn hours(hours: &[Hour]) -> Value {
    let mut out: Vec<Value> = hours.iter().map(|h| json!({"total": h.total, "correct": h.correct})).collect();
    out.resize(24, json!({"total": 0, "correct": 0}));
    json!(out)
}

fn buttons(counts: Option<&ButtonCounts>) -> Value {
    let counts = counts.cloned().unwrap_or_default();
    let four = |v: Vec<u32>| {
        let mut v = v;
        v.resize(4, 0);
        v
    };
    json!({"learning": four(counts.learning), "young": four(counts.young), "mature": four(counts.mature)})
}

impl Engine {
    fn graphs(&mut self, deck: &str) -> Outcome<GraphsResponse> {
        let search = if deck.is_empty() {
            String::new()
        } else {
            format!("\"deck:{}\"", deck.replace('\\', "\\\\").replace('"', "\\\""))
        };
        Ok(self.col()?.graphs(GraphsRequest { search, days: 0 })?)
    }

    /// AnkiBase's AnkiStats for `deck` (empty: the whole collection) over `period`.
    pub fn stats(&mut self, deck: &str, period: &str) -> Outcome<(String, u32, Value)> {
        let days = period_days(period).ok_or_else(|| Failure::new(400, "Invalid period"))?;
        let graphs = self.graphs(deck)?;
        let today = today(graphs.rollover_hour);
        let in_period = |offset: i32| days.is_none_or(|days| -offset < days);

        let mut calendar = Map::new();
        let mut daily = Map::new();
        let reviews = graphs.reviews.clone().unwrap_or_default();
        let counts: BTreeMap<_, _> = reviews.count.iter().collect();
        for (&offset, count) in counts {
            let total = count.learn + count.relearn + count.young + count.mature + count.filtered;
            if total == 0 {
                continue;
            }
            calendar.insert(date(today, offset), json!(total));
            if in_period(offset) {
                let time = reviews.time.get(&offset).cloned().unwrap_or_default();
                let mut day = Map::new();
                for (name, n, ms) in [("learn", count.learn, time.learn), ("relearn", count.relearn, time.relearn),
                                      ("young", count.young, time.young), ("mature", count.mature, time.mature),
                                      ("filtered", count.filtered, time.filtered)] {
                    if n > 0 {
                        day.insert(name.into(), json!(n));
                        day.insert(format!("{name}_s"), json!(ms as f64 / 1000.0));
                    }
                }
                daily.insert(date(today, offset), Value::Object(day));
            }
        }

        let t = graphs.today.clone().unwrap_or_default();
        let hours_all = graphs.hours.clone().unwrap_or_default();
        let hourly = match days {
            Some(30) => &hours_all.one_month,
            Some(91) => &hours_all.three_months,
            Some(365) => &hours_all.one_year,
            _ => &hours_all.all_time,
        };
        let buttons_all = graphs.buttons.clone().unwrap_or_default();
        let button_counts = match days {
            Some(30) => buttons_all.one_month.as_ref(),
            Some(91) => buttons_all.three_months.as_ref(),
            Some(365) => buttons_all.one_year.as_ref(),
            _ => buttons_all.all_time.as_ref(),
        };
        let r = graphs.true_retention.clone().unwrap_or_default();
        let c = graphs.card_counts.clone().unwrap_or_default().excluding_inactive.unwrap_or_default();
        let total = c.new_cards + c.learn + c.relearn + c.young + c.mature + c.suspended + c.buried;

        let intervals: BTreeMap<u32, u32> = graphs.intervals.clone().unwrap_or_default().intervals.into_iter().collect();
        let eases = graphs.eases.clone().unwrap_or_default();
        let mut ease: BTreeMap<u32, u32> = BTreeMap::new();
        for (percent, n) in &eases.eases {
            *ease.entry(((*percent as f64 / 5.0).round() * 5.0) as u32).or_default() += n;
        }
        let future = graphs.future_due.clone().unwrap_or_default();
        let mut future_days: BTreeMap<i32, u32> = BTreeMap::new();
        let mut overdue = 0;
        for (&day, &n) in &future.future_due {
            if day < 0 {
                overdue += n;
            } else {
                future_days.insert(day, n);
            }
        }
        let mut added = Map::new();
        for (&offset, &n) in &graphs.added.clone().unwrap_or_default().added {
            if in_period(offset) && n > 0 {
                added.insert(date(today, offset), json!(n));
            }
        }

        let stats = json!({
            "today": {
                "reviews": t.answer_count, "seconds": t.answer_millis as f64 / 1000.0,
                "again": t.answer_count.saturating_sub(t.correct_count),
                "learn": t.learn_count, "review": t.review_count, "relearn": t.relearn_count,
                "filtered": t.early_review_count, "mature_correct": t.mature_correct, "mature_total": t.mature_count,
            },
            "calendar": calendar,
            "daily": daily,
            "hourly": hours(hourly),
            "buttons": buttons(button_counts),
            "retention": {
                "today": retention(r.today.as_ref()), "yesterday": retention(r.yesterday.as_ref()),
                "week": retention(r.week.as_ref()), "month": retention(r.month.as_ref()),
                "year": retention(r.year.as_ref()), "all": retention(r.all_time.as_ref()),
            },
            "card_counts": {
                "new": c.new_cards, "learning": c.learn, "relearning": c.relearn, "young": c.young,
                "mature": c.mature, "suspended": c.suspended, "buried": c.buried, "total": total,
            },
            "intervals": intervals.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<Map<_, _>>(),
            "ease": ease.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<Map<_, _>>(),
            "ease_avg": (!eases.eases.is_empty()).then_some(eases.average),
            "future_due": {
                "days": future_days.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<Map<_, _>>(),
                "overdue": overdue,
                "learning_today": 0,
                "daily_load": future.daily_load,
                "known": true,
            },
            "added": added,
        });
        Ok((today.format("%Y-%m-%d").to_string(), graphs.rollover_hour, stats))
    }

    /// Reviews per day for the Decks screen's heatmap.
    pub fn review_history(&mut self, deck: &str) -> Outcome<Value> {
        let graphs = self.graphs(deck)?;
        let today = today(graphs.rollover_hour);
        let reviews = graphs.reviews.clone().unwrap_or_default();
        let mut daily_counts = Map::new();
        let mut daily_time = Map::new();
        for (&offset, count) in &reviews.count {
            let total = count.learn + count.relearn + count.young + count.mature + count.filtered;
            if total > 0 {
                daily_counts.insert(date(today, offset), json!(total));
                let time = reviews.time.get(&offset).cloned().unwrap_or_default();
                let ms = time.learn + time.relearn + time.young + time.mature + time.filtered;
                daily_time.insert(date(today, offset), json!(ms as f64 / 1000.0));
            }
        }
        let hourly: Map<String, Value> = graphs
            .hours
            .clone()
            .unwrap_or_default()
            .all_time
            .iter()
            .enumerate()
            .filter(|(_, h)| h.total > 0)
            .map(|(hour, h)| (hour.to_string(), json!(h.total)))
            .collect();
        let t = graphs.today.unwrap_or_default();
        Ok(json!({
            "daily_counts": daily_counts, "daily_time": daily_time, "hourly_counts": hourly,
            "button_counts": {}, "interval_ranges": {},
            "today": t.answer_count, "today_time_seconds": t.answer_millis as f64 / 1000.0,
        }))
    }
}
