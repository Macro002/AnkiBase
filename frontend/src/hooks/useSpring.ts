import { useEffect, useMemo, useRef } from 'react';

export interface SpringConfig {
  /** Higher = snappier. */
  stiffness?: number;
  /** Lower = bouncier (overshoot). */
  damping?: number;
  mass?: number;
}

/** A soft, slightly bouncy default — settles in ~350ms with one small overshoot. */
export const BOUNCY: SpringConfig = { stiffness: 520, damping: 24, mass: 1 };

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

type Values = Record<string, number>;

/**
 * Spring-animates a set of numbers and hands each frame to `apply` (write the DOM
 * there — no React re-render per frame). Retargeting mid-flight keeps the current
 * velocity, so quick repeated changes feel physical rather than restarting.
 *
 *   const spring = useSpring(v => { el.style.transform = `translateX(${v.x}px)` });
 *   spring.set({ x: 120 });            // animate
 *   spring.set({ x: 120 }, true);      // jump (first layout)
 */
export function useSpring<K extends string>(apply: (values: Record<K, number>) => void, config: SpringConfig = BOUNCY) {
  const applyRef = useRef(apply);
  const cfgRef = useRef(config);
  useEffect(() => { applyRef.current = apply; cfgRef.current = config; });

  // All mutable animation state lives in one ref; the methods are created once.
  const engine = useRef<{ x: Values; v: Values; target: Values; raf: number; last: number } | null>(null);

  const api = useMemo(() => {
    const frame = (now: number) => {
      const s = engine.current;
      if (!s) return;
      // Clamp dt so a backgrounded tab doesn't blow up the integration.
      const dt = s.last ? Math.min(0.032, (now - s.last) / 1000) : 1 / 60;
      s.last = now;
      const { stiffness = 520, damping = 24, mass = 1 } = cfgRef.current;
      let moving = false;
      for (const k of Object.keys(s.target)) {
        const force = -stiffness * (s.x[k] - s.target[k]) - damping * s.v[k];
        s.v[k] += (force / mass) * dt;          // semi-implicit Euler
        s.x[k] += s.v[k] * dt;
        if (Math.abs(s.v[k]) > 0.02 || Math.abs(s.x[k] - s.target[k]) > 0.02) moving = true;
        else { s.x[k] = s.target[k]; s.v[k] = 0; }
      }
      applyRef.current({ ...s.x } as Record<K, number>);
      s.raf = moving ? requestAnimationFrame(frame) : 0;
    };

    const set = (target: Record<K, number>, immediate = false) => {
      const t = target as Values;
      const s = engine.current;
      if (!s || immediate || reducedMotion()) {
        if (s?.raf) cancelAnimationFrame(s.raf);
        engine.current = { x: { ...t }, v: Object.fromEntries(Object.keys(t).map(k => [k, 0])), target: { ...t }, raf: 0, last: 0 };
        applyRef.current({ ...t } as Record<K, number>);
        return;
      }
      for (const k of Object.keys(t)) if (!(k in s.x)) { s.x[k] = t[k]; s.v[k] = 0; }
      s.target = { ...t };
      if (!s.raf) { s.last = 0; s.raf = requestAnimationFrame(frame); }
    };

    return { set };
  }, []);

  useEffect(() => () => { if (engine.current?.raf) cancelAnimationFrame(engine.current.raf); }, []);
  return api;
}
