import { useState, type ReactNode } from 'react';
import { Table2, BarChart3 } from 'lucide-react';

export interface TipRow { color?: string; label: string; value: string }

/** Tooltip body: value first and bright, series name secondary, keyed by a short line. */
export function TipBox({ title, rows, footer }: { title: string; rows: TipRow[]; footer?: ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-(--bg-primary)/95 backdrop-blur px-3 py-2 shadow-xl text-xs min-w-36">
      <p className="text-(--text-secondary) mb-1.5">{title}</p>
      <div className="space-y-1">
        {rows.map(r => (
          <div key={r.label} className="flex items-center gap-2">
            {r.color && <span className="w-2.5 h-0.5 rounded-full shrink-0" style={{ background: r.color }} />}
            <span className="font-semibold text-white tabular-nums">{r.value}</span>
            <span className="text-(--text-secondary)">{r.label}</span>
          </div>
        ))}
      </div>
      {footer && <div className="mt-1.5 pt-1.5 border-t border-white/10 text-(--text-secondary)">{footer}</div>}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-(--text-secondary)">
      {items.map(i => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: i.color }} />{i.label}
        </span>
      ))}
    </div>
  );
}

export interface TableData { columns: string[]; rows: (string | number)[][] }

/** One stats section: title, optional summary line, the chart — and a table view of the same data. */
export function ChartCard({ title, subtitle, summary, actions, table, children, className = '' }: {
  title: string; subtitle?: string; summary?: ReactNode; actions?: ReactNode; table?: TableData; children: ReactNode; className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`card space-y-4 min-w-0 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">{title}</h3>
          {subtitle && <p className="text-xs text-(--text-secondary) mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {actions}
          {table && (
            <button onClick={() => setAsTable(t => !t)} title={asTable ? 'Show chart' : 'Show table'} aria-pressed={asTable}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${asTable ? 'bg-(--accent)/15 text-(--accent)' : 'bg-(--bg-tertiary) text-(--text-secondary) hover:text-white'}`}>
              {asTable ? <BarChart3 className="w-4 h-4" /> : <Table2 className="w-4 h-4" />}
            </button>
          )}
        </div>
      </div>
      {asTable && table ? <DataTable data={table} /> : children}
      {summary && <div className="text-xs text-(--text-secondary) flex flex-wrap gap-x-5 gap-y-1">{summary}</div>}
    </section>
  );
}

export function DataTable({ data, align }: { data: TableData; align?: ('left' | 'right')[] }) {
  const right = (i: number) => (align ? align[i] === 'right' : i > 0);
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-white/8">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-(--bg-secondary)">
          <tr>{data.columns.map((c, i) => <th key={c} className={`px-3 py-2 font-semibold text-(--text-secondary) ${right(i) ? 'text-right' : 'text-left'}`}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {data.rows.map((r, ri) => (
            <tr key={ri} className="border-t border-white/5">
              {r.map((v, i) => <td key={i} className={`px-3 py-1.5 ${right(i) ? 'text-right tabular-nums' : ''}`}>{v}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A labelled number; `hint` sits under it in muted ink. */
export function Stat({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: ReactNode; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-(--bg-tertiary)/50 px-4 py-3 min-w-0">
      <p className="text-xs text-(--text-secondary)">{label}</p>
      <p className={`text-2xl font-semibold mt-0.5 ${accent ? 'text-(--accent)' : ''}`}>{value}</p>
      {hint && <p className="text-xs text-(--text-secondary) mt-0.5 truncate">{hint}</p>}
    </div>
  );
}

/** Summary item used in a ChartCard's summary line. */
export function S({ k, v }: { k: string; v: ReactNode }) {
  return <span>{k} <span className="text-white font-medium">{v}</span></span>;
}
