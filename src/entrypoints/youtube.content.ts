import { hostIsCovered, normalizeHost } from '../lib/hosts';
import { loadSettings, SETTINGS_KEY, type Settings } from '../lib/settings';

const FLAG = 'block-youtube';
const STYLE_ID = 'block-youtube-cosmetic';

// #player-ads stays in the page. YouTube treats a hidden slot as an ad blocker
// and replaces the video with the terms-of-service wall. Ad payloads are removed
// in the player script, so the slot does not fill.
const HIDDEN = [
  'ytd-ad-slot-renderer',
  'ytd-banner-promo-renderer',
  'ytd-in-feed-ad-layout-renderer',
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
  '.ytp-ad-overlay-container',
  '.ytp-ad-image-overlay',
].join(',');

export default defineContentScript({
  matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'],
  runAt: 'document_start',
  noScriptStartedPostMessage: true,
  main() {
    void publish();
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[SETTINGS_KEY]) void publish();
    });

    let timer = 0;
    const tick = () => {
      const ad = skipShowingAd();
      if (ad && timer === 0) timer = window.setInterval(tick, 200);
      if (!ad && timer !== 0) {
        window.clearInterval(timer);
        timer = 0;
      }
    };
    const observer = new MutationObserver(tick);
    const watch = () => {
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
        subtree: true,
      });
      tick();
    };
    if (document.documentElement) watch();
    else document.addEventListener('DOMContentLoaded', watch, { once: true });
  },
});

async function publish() {
  const settings = await loadSettings();
  const on = blockingOn(settings);
  try {
    sessionStorage.setItem(FLAG, on ? '1' : '0');
  } catch {
    // A sandboxed frame cannot use sessionStorage. The player script then stays on.
  }
  applyCosmetic(on);
}

function blockingOn(settings: Settings): boolean {
  if (!settings.enabled) return false;
  const host = normalizeHost(location.hostname);
  if (!host) return true;
  return !settings.pausedHosts.some((root) => hostIsCovered(host, root));
}

function applyCosmetic(on: boolean) {
  const mount = () => {
    const parent = document.documentElement ?? document.head;
    if (!parent) return;
    const existing = document.getElementById(STYLE_ID);
    if (!on) {
      existing?.remove();
      return;
    }
    const style = existing ?? document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `${HIDDEN}{display:none !important}`;
    if (!style.parentNode) parent.append(style);
  };
  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

let savedPlayback: { rate: number; muted: boolean } | null = null;

function restorePlayback() {
  if (!savedPlayback) return;
  const current = document.querySelector('#movie_player video, .html5-video-player video');
  if (current instanceof HTMLVideoElement) {
    current.playbackRate = savedPlayback.rate;
    current.muted = savedPlayback.muted;
  }
  savedPlayback = null;
}

function skipShowingAd(): boolean {
  try {
    if (sessionStorage.getItem(FLAG) === '0') {
      restorePlayback();
      return false;
    }
  } catch {
    return false;
  }
  const root = document.querySelector('.ad-showing');
  const video = root?.querySelector('video');
  if (!root || !(video instanceof HTMLVideoElement)) {
    restorePlayback();
    return false;
  }

  if (!savedPlayback) savedPlayback = { rate: video.playbackRate, muted: video.muted };
  if (video.playbackRate < 8) video.playbackRate = 16;
  video.muted = true;
  if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.2) {
    video.currentTime = Math.max(0, video.duration - 0.05);
  }
  const skip = root.querySelector<HTMLElement>(
    '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern',
  );
  skip?.click();
  return true;
}
