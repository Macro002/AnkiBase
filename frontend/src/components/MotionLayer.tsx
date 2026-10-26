import { useEffect } from 'react';

/**
 * Exit animations for every overlay without touching each dialog: when a full-screen
 * overlay (`.fixed.inset-0`) is removed, a frozen, non-interactive copy is shown for a
 * moment and animated out (fade + pop-out, styles in index.css).
 * Opt out per element with `data-no-exit`.
 */
export function MotionLayer() {
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const obs = new MutationObserver(records => {
      for (const r of records) {
        r.removedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          if (!node.classList.contains('fixed') || !node.classList.contains('inset-0')) return;
          if (node.hasAttribute('data-no-exit') || node.classList.contains('motion-ghost')) return;
          if (!node.querySelector('*') && !/bg-black/.test(node.className)) return; // bare click-catchers
          const ghost = node.cloneNode(true) as HTMLElement;
          ghost.classList.add('motion-ghost');
          ghost.setAttribute('aria-hidden', 'true');
          ghost.removeAttribute('id');
          ghost.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
          document.body.appendChild(ghost);
          setTimeout(() => ghost.remove(), 200);
        });
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
  return null;
}
