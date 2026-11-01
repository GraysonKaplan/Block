import { normalizeHost } from '../lib/hosts';
import { SETTINGS_KEY } from '../lib/settings';

const STYLE_ID = 'block-cosmetic';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    const host = normalizeHost(location.hostname);
    if (!host) return;

    const apply = () => void render(host);
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[SETTINGS_KEY]) apply();
    });
    apply();
  },
});

async function render(host: string) {
  try {
    const css = await browser.runtime.sendMessage({ type: 'cosmetic-css', host });
    applyCss(typeof css === 'string' ? css : '');
  } catch {
    applyCss('');
  }
}

// The injected stylesheet covers elements added later. The file fetch can lag the first paint.
function applyCss(css: string) {
  const existing = document.getElementById(STYLE_ID);
  if (!css) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  if (!style.parentNode) (document.documentElement ?? document.head).append(style);
}
