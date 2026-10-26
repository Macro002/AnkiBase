import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { mediaUrl } from './media';

/**
 * Renders an Anki card the way Anki does — the note type's own HTML/CSS on a
 * `<body class="card nightMode">` — inside a sandboxed iframe:
 *  - deck CSS can't leak into the app (and the app's CSS can't break the card)
 *  - card scripts run, but in an opaque origin with no access to the app or its cookies
 *  - media load from signed URLs; [anki:play] tags become play buttons; MathJax when needed
 * The frame reports its height, taps (to reveal) and key presses back to the page.
 */

export interface FrameEvents {
  onTap?: () => void;
  onKey?: (e: { key: string; code: string; ctrl: boolean }) => void;
  onPlay?: (index: number, side: 'q' | 'a') => void;
}

function themeVars() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return { text: v('--text-primary', '#eee'), muted: v('--text-secondary', '#aaa'), accent: v('--accent', '#e94560'), surface: v('--bg-tertiary', '#0f3460') };
}

const esc = (s: string) => s.replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]!));


/** Point local media references (img/audio/video src, CSS url()) at the media endpoint. */
function rewriteMedia(html: string, token: string): string {
  const local = (u: string) => !/^(?:[a-z]+:|\/\/|#|\/)/i.test(u);
  return html
    .replace(/(<(?:img|audio|video|source)\b[^>]*?\ssrc\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, src) => (local(src) ? `${pre}${q}${esc(mediaUrl(decodeHtml(src), token))}${q}` : m))
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, src) => (local(src) ? `url(${q}${mediaUrl(src, token)}${q})` : m));
}

function decodeHtml(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function buildDoc(html: string, css: string, token: string, frameId: string, side: 'q' | 'a'): string {
  const t = themeVars();
  const body = rewriteMedia(html, token)
    .replace(/\[anki:play:([qa]):(\d+)\]/g, (_m, s, i) => `<button class="ab-play" data-play="${i}" data-side="${s}" aria-label="Play audio">▶</button>`)
    .replace(/\[sound:[^\]]+\]/g, '')
    .replace(/\[\[type:[^\]]+\]\]/g, '<input id="typeans" class="typeans" placeholder="Type your answer" autocomplete="off" spellcheck="false">');
  const needsMath = /\\\(|\\\[|\$\$/.test(body);
  const base = `
    html,body{margin:0;padding:0;background:transparent}
    body{color:${t.text};font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:20px;line-height:1.5;text-align:center;padding:28px 22px;overflow-wrap:anywhere;-webkit-text-size-adjust:100%}
    body.nightMode{background-color:transparent;color:${t.text}}
    img{max-width:100%;height:auto}
    video{max-width:100%}
    a{color:${t.accent}}
    hr,hr#answer{border:0;border-top:1px solid rgba(255,255,255,.14);margin:22px 0}
    .cloze{font-weight:bold;color:#5ea2ff}
    table{margin:0 auto;border-collapse:collapse}
    td,th{padding:4px 8px}
    .ab-play{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;margin:0 4px;vertical-align:middle;border:0;border-radius:999px;background:${t.surface};color:${t.text};font-size:13px;cursor:pointer}
    .ab-play:hover{background:${t.accent};color:#fff}
    #typeans{font:inherit;font-size:18px;width:min(100%,420px);padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.25);color:inherit;text-align:center}
  `;
  const bridge = `
    (function(){
      var id=${JSON.stringify(frameId)};
      function send(m){m.ankiFrame=id;parent.postMessage(m,'*');}
      function size(){send({type:'h',h:Math.ceil(document.documentElement.getBoundingClientRect().height)});}
      new ResizeObserver(size).observe(document.body);
      window.addEventListener('load',size);
      document.addEventListener('click',function(e){
        var b=e.target.closest&&e.target.closest('[data-play]');
        if(b){e.preventDefault();send({type:'play',i:+b.dataset.play,side:b.dataset.side});return;}
        if(!(e.target.closest&&e.target.closest('a,input,button,textarea,select,summary,label,[onclick]')))send({type:'tap'});
      });
      document.addEventListener('keydown',function(e){
        var tag=(e.target&&e.target.tagName)||'';
        if(tag==='INPUT'||tag==='TEXTAREA'){if(e.key!=='Enter')return;}
        if([' ','Enter','1','2','3','4','r','R','z','Z','e','E','Escape'].indexOf(e.key)>=0)e.preventDefault();
        send({type:'key',key:e.key,code:e.code,ctrl:e.ctrlKey||e.metaKey});
      });
    })();`;
  const math = needsMath
    ? `<script>window.MathJax={tex:{inlineMath:[['\\\\(','\\\\)']],displayMath:[['\\\\[','\\\\]'],['$$','$$']]},svg:{fontCache:'global'}};</script>
       <script src="https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js" async></script>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<base target="_blank"><style>${base}</style><style>${rewriteMedia(css, token)}</style>${math}</head>
<body class="card nightMode night_mode" data-side="${side}"><div id="qa">${body}</div><script>${bridge}</script></body></html>`;
}

export function CardFrame({ html, css, token, side, events, minHeight = 220 }: {
  html: string; css: string; token: string; side: 'q' | 'a'; events: FrameEvents; minHeight?: number;
}) {
  const frameId = useId();
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  const evRef = useRef(events);
  useEffect(() => { evRef.current = events; });
  const doc = useMemo(() => buildDoc(html, css, token, frameId, side), [html, css, token, frameId, side]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.ankiFrame !== frameId || e.source !== ref.current?.contentWindow) return;
      if (m.type === 'h') setHeight(Math.max(minHeight, Math.min(m.h, 4000)));
      else if (m.type === 'tap') evRef.current.onTap?.();
      else if (m.type === 'key') evRef.current.onKey?.({ key: m.key, code: m.code, ctrl: !!m.ctrl });
      else if (m.type === 'play') evRef.current.onPlay?.(m.i, m.side === 'a' ? 'a' : 'q');
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [frameId, minHeight]);

  return (
    <iframe ref={ref} title="Card" srcDoc={doc} sandbox="allow-scripts allow-popups" allow="autoplay"
      className="w-full block border-0 transition-[height] duration-200 ease-out" style={{ height }} />
  );
}
