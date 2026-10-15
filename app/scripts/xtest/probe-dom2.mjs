/* 探查 2：定位曲目/分类卡片的真实容器与关键选择器（只读） */
import { attach, sleep } from './cdp.mjs';

const t = await attach(9235);
await sleep(400);

const info = await t.ev(`(() => {
  const desc = (e) => e ? { tag: e.tagName, id: e.id, cls: e.className } : null;
  const tracks = [...document.querySelectorAll('.cat-track')].map(e => ({
    self: e.className,
    parent: desc(e.parentElement),
    gp: desc(e.parentElement && e.parentElement.parentElement),
    text: (e.textContent || '').trim().slice(0, 20),
  }));
  const catCards = document.querySelector('#catCards');
  return {
    tracks,
    catCardsHTMLLen: catCards ? catCards.innerHTML.length : -1,
    catCardsFirstChild: catCards && catCards.firstElementChild ? catCards.firstElementChild.className : null,
    catListChildren: [...document.querySelectorAll('#catList > *')].map(e => e.className).slice(0, 8),
    catListTrackCount: document.querySelectorAll('#catList .cat-track').length,
    selCatName: document.getElementById('selCatName')?.textContent,
    selCatCount: document.getElementById('selCatCount')?.textContent,
    nowTrack: document.getElementById('nowTrack')?.textContent,
    videoChipCount: document.querySelectorAll('#videoChips > *').length,
    pptChipCount: document.querySelectorAll('#pptChips > *').length,
    hasStateOnWindow: typeof window.state,
    hasApi: typeof window.api,
    apiKeys: window.api ? Object.keys(window.api) : [],
  };
})()`);

console.log(JSON.stringify(info, null, 2));
t.close();
