import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtDuration } from '../lib/format.js';

/*
 * Chart conventions (see dataviz guidance): thin marks, recessive grid/axes,
 * 2px lines, 4px rounded bar ends, status colors only for status, a legend for
 * every multi-series chart, and a hover tooltip on everything.
 */
const AXIS = { stroke: 'var(--axis)', tick: { fill: 'var(--muted)', fontSize: 11 }, tickLine: false };
const STATUS_SERIES = [
  { key: 'passed', label: 'Passed', color: 'var(--good)' },
  { key: 'failed', label: 'Failed', color: 'var(--critical)' },
  { key: 'errored', label: 'Error', color: 'var(--serious)' },
];

function TooltipBox({ active, payload, label, title, rows }) {
  if (!active || !payload?.length) return null;
  const datum = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="t">{title ? title(datum, label) : label}</div>
      {rows(datum).map((r) => (
        <div className="r" key={r.label}>
          {r.color && <i style={{ background: r.color }} />}
          {r.label}
          <b>{r.value}</b>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Pass rate per run — single series, so no legend box; the card title names it. */
export function PassRateChart({ data, height = 260 }) {
  return (
    <div className="chart-box" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="passFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="label" {...AXIS} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} unit="%" {...AXIS} axisLine={false} width={48} />
          <Tooltip
            cursor={{ stroke: 'var(--axis)', strokeDasharray: '3 3' }}
            content={(p) => (
              <TooltipBox
                {...p}
                title={(d) => `${d.label} · ${d.name}`}
                rows={(d) => [
                  { label: 'Pass rate', value: `${d.passRate}%`, color: 'var(--primary)' },
                  { label: 'Passed', value: d.passed },
                  { label: 'Failed + errors', value: d.failed + d.errored },
                ]}
              />
            )}
          />
          <Area
            type="monotone"
            dataKey="passRate"
            stroke="var(--primary)"
            strokeWidth={2}
            fill="url(#passFill)"
            dot={{ r: 3, strokeWidth: 2, fill: 'var(--surface-solid)' }}
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface-solid)', fill: 'var(--primary)' }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Stacked results per run, in status colors. */
export function ResultsStackChart({ data, height = 260 }) {
  return (
    <>
      <Legend items={STATUS_SERIES} />
      <div className="chart-box" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: -18 }} barCategoryGap="22%">
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="label" {...AXIS} />
            <YAxis allowDecimals={false} {...AXIS} axisLine={false} width={40} />
            <Tooltip
              cursor={{ fill: 'var(--surface-hover)' }}
              content={(p) => (
                <TooltipBox
                  {...p}
                  title={(d) => `${d.label} · ${d.name}`}
                  rows={(d) => STATUS_SERIES.map((s) => ({ label: s.label, value: d[s.key], color: s.color }))}
                />
              )}
            />
            {STATUS_SERIES.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId="a"
                fill={s.color}
                stroke="var(--surface-solid)"
                strokeWidth={1}
                radius={i === STATUS_SERIES.length - 1 ? [4, 4, 0, 0] : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

export function DurationChart({ data, height = 240 }) {
  return (
    <div className="chart-box" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="label" {...AXIS} />
          <YAxis {...AXIS} axisLine={false} width={56} tickFormatter={(v) => fmtDuration(v)} />
          <Tooltip
            cursor={{ stroke: 'var(--axis)', strokeDasharray: '3 3' }}
            content={(p) => (
              <TooltipBox
                {...p}
                title={(d) => `${d.label} · ${d.name}`}
                rows={(d) => [{ label: 'Run duration', value: fmtDuration(d.durationMs), color: 'var(--violet)' }]}
              />
            )}
          />
          <Line
            type="monotone"
            dataKey="durationMs"
            stroke="var(--violet)"
            strokeWidth={2}
            dot={{ r: 3, strokeWidth: 2, fill: 'var(--surface-solid)' }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal magnitude bars built in HTML — crisp labels, hover title per row. */
export function HBarList({ items, value, label, format = (v) => v, color = 'var(--primary)', max }) {
  const top = max ?? Math.max(1, ...items.map(value));
  return (
    <div>
      {items.map((item, i) => {
        const v = value(item);
        return (
          <div className="hbar" key={i} title={`${label(item)}: ${format(v)}`}>
            <span className="truncate ink-2" style={{ fontWeight: 600 }}>
              {label(item)}
            </span>
            <span className="hbar-track">
              <span className="hbar-fill" style={{ display: 'block', width: `${Math.max((v / top) * 100, 1.5)}%`, background: color }} />
            </span>
            <span className="num small" style={{ textAlign: 'right', fontWeight: 700 }}>
              {format(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
