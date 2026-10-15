/* DOM 探查：搞清楚当前 UI 的真实结构，供后续断言使用（只读） */
import { attach, sleep } from './cdp.mjs';

const t = await attach(9235);
await sleep(500);

const info = await t.ev(`(() => {
  const ids = [...document.querySelectorAll('[id]')].map(e => e.id).filter(Boolean);
  const cards = [...document.querySelectorAll('#catCards .cat-card')].slice(0, 3).map(c => ({
    cls: c.className,
    trackSel: [...c.querySelectorAll('*')].map(e => e.className).filter(c => typeof c === 'string' && c.includes('track')).slice(0, 6),
    childClasses: [...c.children].map(e => e.className),
    trackCount: c.querySelectorAll('.cat-track').length,
    pinCount: c.querySelectorAll('.cat-pin').length,
  }));
  return {
    bodyClass: document.body.className,
    ids: ids.slice(0, 120),
    catCardCount: document.querySelectorAll('#catCards .cat-card').length,
    catTrackTotal: document.querySelectorAll('.cat-track').length,
    catPinTotal: document.querySelectorAll('.cat-pin').length,
    cards,
    engine: { cats: window.engine.categories.length, idx: window.engine.idx, playing: window.engine.playing, ctx: !!window.engine.ctx },
    state: { video: window.state && window.state.video, ppt: window.state && window.state.ppt, mode: window.state && window.state.mode },
  };
})()`);

console.log(JSON.stringify(info, null, 2));
t.close();
