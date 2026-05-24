const chyronConfig = {
  'index.html': { tag: 'LIVE', color: 'neon-pink', body: 'Competition Season 2026' },
  'info.html': { tag: 'INFO', color: 'neon-blue', body: 'Site & Author' },
  'body.html': { tag: 'BODY', color: 'neon-green', body: 'Physical Training' },
  'mind.html': { tag: 'MIND', color: 'neon-pink', body: 'Mental Skills' },
  'tech.html': { tag: 'TECH', color: 'neon-blue', body: 'Technical' },
  'comp.html': { tag: 'COMP', color: 'neon-pink', body: 'Competition Notes' },
  'gear.html': { tag: 'GEAR', color: 'neon-green', body: 'Equipment' }
};

const page = (location.pathname.split('/').pop() || 'index.html');
const config = chyronConfig[page];

if (config) {
  const chyronSlot = document.getElementById('header-chyron');
  if (chyronSlot) {
    chyronSlot.innerHTML = `<span class="chyron"><span class="chyron-tag ${config.color}">${config.tag}</span><span class="chyron-body">${config.body}</span></span>`;
  }
}
