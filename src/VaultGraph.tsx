import { useEffect, useRef } from 'react';
import type { VaultGraph as Graph } from '../shared/types';

interface Body { id: string; label: string; type: string; x: number; y: number; vx: number; vy: number; r: number; }
const COLORS: Record<string, string> = { hub: '#e6edf3', user: '#58a6ff', feedback: '#f0883e', project: '#3fb950', reference: '#a371f7', other: '#8b949e' };
export const HIGHLIGHT_MS = 10000;
/** Scale (never above 1) and centre that fit every point inside a w×h box with a margin for labels. */
export function fitTransform(points: { x: number; y: number }[], w: number, h: number): { scale: number; cx: number; cy: number } {
  if (!points.length) return { scale: 1, cx: 0, cy: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  return { scale: Math.min(1, (w - 40) / Math.max(1, maxX - minX), (h - 30) / Math.max(1, maxY - minY)), cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}
/** Frames are drawn only while something changes: layout settling, a hover or pulse, thinking, or a highlight younger than HIGHLIGHT_MS. */
export const shouldAnimate = (st: { hot: number; settled: boolean; thinking: boolean; highlightAt: number; pulseAt: number }, now: number, reduce: boolean): boolean =>
  st.hot > 0 || !st.settled || (!reduce && (st.thinking || now - st.highlightAt < HIGHLIGHT_MS || now - st.pulseAt < 1500));

/** Force-directed vault graph fitted to its canvas. Thinking: a brightness wave. Answered: named notes glow for ten seconds. Idle: no drawing. */
export default function VaultGraph({ graph, thinking, highlight, pulse }: { graph: Graph | null; thinking: boolean; highlight: string[]; pulse: string }) {
  const canvas = useRef<HTMLCanvasElement>(null), bodies = useRef(new Map<string, Body>());
  const s = useRef({ thinking, highlight, highlightAt: -Infinity, pulse, pulseAt: -Infinity, hot: 1, settled: false, edges: [] as { from: string; to: string }[], hover: '', view: { scale: 1, cx: 0, cy: 0 } });
  s.current.thinking = thinking;
  if (s.current.highlight !== highlight) { s.current.highlight = highlight; s.current.highlightAt = highlight.length ? performance.now() : -Infinity; s.current.hot = 1; }
  if (s.current.pulse !== pulse) { s.current.pulse = pulse; s.current.pulseAt = performance.now(); s.current.hot = 1; }
  useEffect(() => {
    if (!graph) return; const map = bodies.current, seen = new Set<string>();
    graph.nodes.forEach((n, i) => { seen.add(n.id); const b = map.get(n.id); if (b) { b.label = n.label; b.type = n.type; return; } const a = i * 2.4, d = 20 + Math.sqrt(i) * 14; map.set(n.id, { id: n.id, label: n.label, type: n.type, x: Math.cos(a) * d, y: Math.sin(a) * d, vx: 0, vy: 0, r: n.type === 'hub' ? 7 : 3.5 }); });
    for (const id of [...map.keys()]) if (!seen.has(id)) map.delete(id);
    s.current.edges = graph.edges; s.current.settled = false; s.current.hot = 1;
  }, [graph]);
  useEffect(() => {
    const el = canvas.current!, ctx = el.getContext('2d')!, reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; let frame = 0;
    const move = (e: MouseEvent) => { const b = el.getBoundingClientRect(), v = s.current.view, x = (e.clientX - b.left - b.width / 2) / v.scale + v.cx, y = (e.clientY - b.top - b.height / 2) / v.scale + v.cy; let best = '', d = 12 / v.scale; for (const n of bodies.current.values()) { const dd = Math.hypot(n.x - x, n.y - y); if (dd < d) { d = dd; best = n.id; } } if (best !== s.current.hover) { s.current.hover = best; s.current.hot = 1; } };
    el.addEventListener('mousemove', move);
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const st = s.current, nodes = [...bodies.current.values()], w = el.clientWidth, h = el.clientHeight; if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1; if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); st.hot = 1; }
      if (!shouldAnimate(st, now, reduce)) return;
      if (!st.settled && nodes.length) {
        // ponytail: O(n²) repulsion each frame; fine for a few hundred notes, use a grid or Barnes-Hut past a few thousand.
        let energy = 0;
        for (const a of nodes) { let fx = -a.x * 0.002, fy = -a.y * 0.002; for (const b of nodes) { if (a === b) continue; const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 1, f = 60 / d2; fx += dx * f; fy += dy * f; } a.vx = (a.vx + fx) * 0.85; a.vy = (a.vy + fy) * 0.85; }
        for (const e of st.edges) { const a = bodies.current.get(e.from), b = bodies.current.get(e.to); if (!a || !b) continue; const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, f = (d - 40) * 0.01; a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f; }
        for (const n of nodes) { n.x += n.vx; n.y += n.vy; energy += Math.abs(n.vx) + Math.abs(n.vy); }
        if (energy < 0.02 * nodes.length) st.settled = true;
      } else if (!nodes.length) st.settled = true;
      const view = st.view = fitTransform(nodes, w, h), t = now / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const pos = new Map(nodes.map(n => [n.id, { x: w / 2 + (n.x - view.cx) * view.scale, y: h / 2 + (n.y - view.cy) * view.scale }]));
      const lit = (n: Body) => (now - st.highlightAt < HIGHLIGHT_MS && st.highlight.includes(n.label)) || (st.pulse.startsWith(n.label + ':') && now - st.pulseAt < 1500);
      ctx.lineWidth = 1;
      for (const e of st.edges) { const a = pos.get(e.from), b = pos.get(e.to), na = bodies.current.get(e.from), nb = bodies.current.get(e.to); if (!a || !b || !na || !nb) continue; ctx.strokeStyle = lit(na) || lit(nb) ? 'rgba(230,237,243,0.55)' : 'rgba(140,153,168,0.18)'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      nodes.forEach(n => { const p = pos.get(n.id)!, glow = lit(n) ? 1 : st.thinking && !reduce ? 0.5 + 0.5 * Math.sin(t * 4 - (p.x / w) * 6) : 0, r = Math.max(2, n.r * Math.max(view.scale, 0.5)); ctx.beginPath(); ctx.arc(p.x, p.y, r + glow * 2, 0, Math.PI * 2); ctx.fillStyle = COLORS[n.type] || COLORS.other; ctx.globalAlpha = 0.55 + glow * 0.45; ctx.fill(); ctx.globalAlpha = 1; if (lit(n) || n.id === st.hover || n.type === 'hub') { ctx.fillStyle = '#c9d1d9'; ctx.font = '10px Inter, system-ui, sans-serif'; ctx.fillText(n.label, p.x + r + 3, p.y + 3); } });
      if (!nodes.length) { ctx.fillStyle = '#6f7b88'; ctx.font = '11px Inter, system-ui, sans-serif'; ctx.fillText('No memories yet', 12, 20); }
      st.hot = Math.max(0, st.hot - 0.02);
    };
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); el.removeEventListener('mousemove', move); };
  }, []);
  return <canvas className="vault-graph" ref={canvas} aria-label="Vault graph" role="img" />;
}
