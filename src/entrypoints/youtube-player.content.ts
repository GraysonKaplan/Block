const FLAG = 'block-youtube';
const HOOK = '__blockYoutubeHooks';

type Page = Window & {
  [HOOK]?: boolean;
  JSON: typeof JSON;
  Promise: typeof Promise;
  XMLHttpRequest: typeof XMLHttpRequest;
  HTMLIFrameElement: typeof HTMLIFrameElement;
  ytInitialPlayerResponse?: unknown;
  ytcfg?: {
    data_?: {
      INNERTUBE_CONTEXT?: {
        client?: { userAgent?: string; clientName?: string; clientScreen?: string };
      };
    };
  };
};

type YtPlayer = HTMLElement & {
  getPlayerResponse?: () => PlayerResponse | undefined;
  getStatsForNerds?: () => { debug_info?: string } | undefined;
  getProgressState?: () => { duration?: number } | undefined;
  seekTo?: (seconds: number, allowSeekAhead: boolean) => void;
  loadVideoById?: (videoId: string, startSeconds?: number) => void;
};

type PlayerResponse = {
  videoDetails?: { videoId?: string };
  playabilityStatus?: { status?: string };
  playerConfig?: { playbackStartConfig?: { startSeconds?: number } };
};

type Outbound = {
  attestationRequest?: unknown;
  createCommentParams?: unknown;
  playabilityStatus?: unknown;
  videoDetails?: unknown;
  streamingData?: unknown;
  params?: string;
  context?: {
    client?: { userAgent?: string; clientName?: string; clientScreen?: string };
  };
  playbackContext?: {
    contentPlaybackContext?: { lactMilliseconds?: string; referer?: string };
  };
};

const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];
const TOKENS = ['channel', 'lactmilli', 'inline', 'yahi'];
const TOKEN_MARK = /(?:^|;\s*)(?:adunit|channel|lactmilli|instream|inline|yahi|eafg)\b/;

let originalUserAgent: string | undefined;
let remainingTokens = [...TOKENS];
let recovering = false;
let watchedVideo = '';

export default defineContentScript({
  matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  matchAboutBlank: true,
  globalName: false,
  noScriptStartedPostMessage: true,
  main() {
    install(window as Page);
  },
});

function enabled(): boolean {
  try {
    return sessionStorage.getItem(FLAG) !== '0';
  } catch {
    return true;
  }
}

function isTop(page: Page): boolean {
  try {
    return page.top === page;
  } catch {
    return false;
  }
}

function install(page: Page) {
  try {
    if (page[HOOK]) return;
    page[HOOK] = true;
    hookJson(page);
    hookFetch(page);
    hookXhr(page);
    if (!isTop(page)) return;
    trapPlayerResponse(page);
    blockCleanRealm(page);
    shortenSkipTimer(page);
    neutralizeAbnormality(page);
    watchPlayer(page);
  } catch {
    // A cross-origin frame cannot be hooked. The top page still is.
  }
}

function hookJson(page: Page) {
  const json = page.JSON;
  const parse = json.parse;
  const stringify = json.stringify;
  json.parse = function (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
    const value: unknown = reviver ? parse(text, reviver) : parse(text);
    if (enabled() && typeof text === 'string' && mentionsAds(text)) {
      try {
        strip(value);
      } catch {
        // Leave the original value. A failed walk must not break the player.
      }
    }
    return value;
  } as typeof json.parse;

  json.stringify = function (
    value: unknown,
    replacer?: ((this: unknown, key: string, value: unknown) => unknown) | (string | number)[] | null,
    space?: string | number,
  ) {
    if (enabled() && value && typeof value === 'object') {
      try {
        editOutbound(value as Outbound);
      } catch {
        // A request that does not match the player shape is sent unchanged.
      }
    }
    return stringify.call(json, value, replacer as never, space);
  } as typeof json.stringify;
}

function hookFetch(page: Page) {
  const original = page.fetch.bind(page);
  page.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const pending = original(input, init);
    if (!enabled() || !isPlayerCall(requestUrl(input))) return pending;
    return pending.then((response) => cleanResponse(page, response));
  };
}

function hookXhr(page: Page) {
  const proto = page.XMLHttpRequest.prototype;
  const text = Object.getOwnPropertyDescriptor(proto, 'responseText');
  const body = Object.getOwnPropertyDescriptor(proto, 'response');
  if (text?.get && text.configurable) {
    const read = text.get;
    Object.defineProperty(proto, 'responseText', {
      configurable: true,
      enumerable: text.enumerable,
      get() {
        return cleanXhrValue(this, read.call(this));
      },
    });
  }
  if (body?.get && body.configurable) {
    const read = body.get;
    Object.defineProperty(proto, 'response', {
      configurable: true,
      enumerable: body.enumerable,
      get() {
        return cleanXhrValue(this, read.call(this));
      },
    });
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isPlayerCall(url: string): boolean {
  return (
    /\/player(?:\?|$)/.test(url) ||
    url.includes('/youtubei/v1/next') ||
    url.includes('/youtubei/v1/reel/') ||
    url.includes('/get_watch') ||
    url.includes('/resolve_url') ||
    url.includes('playlist?')
  );
}

function mentionsAds(text: string): boolean {
  return (
    text.includes('"adPlacements"') ||
    text.includes('"playerAds"') ||
    text.includes('"adSlots"') ||
    text.includes('"adBreakHeartbeatParams"')
  );
}

async function cleanResponse(page: Page, response: Response): Promise<Response> {
  try {
    const text = await response.clone().text();
    if (!mentionsAds(text)) return response;
    const value: unknown = page.JSON.parse(text);
    strip(value);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    const cleaned = new Response(page.JSON.stringify(value), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    return cleaned;
  } catch {
    return response;
  }
}

function cleanXhrValue(xhr: XMLHttpRequest, value: unknown): unknown {
  if (!enabled() || !isPlayerCall(xhr.responseURL)) return value;
  if (typeof value === 'string') {
    if (!mentionsAds(value)) return value;
    try {
      const parsed: unknown = JSON.parse(value);
      strip(parsed);
      return JSON.stringify(parsed);
    } catch {
      return value;
    }
  }
  if (value && typeof value === 'object') strip(value);
  return value;
}

function trapPlayerResponse(page: Page) {
  let current = page.ytInitialPlayerResponse;
  try {
    Object.defineProperty(page, 'ytInitialPlayerResponse', {
      configurable: true,
      enumerable: true,
      get() {
        return current;
      },
      set(value: unknown) {
        current = enabled() ? strip(value) : value;
      },
    });
  } catch {
    if (current && enabled()) strip(current);
    return;
  }
  if (current && enabled()) current = strip(current);
}

// YouTube reads fetch from a blank frame so a page hook is not the one it calls.
function blockCleanRealm(page: Page) {
  const proto = page.HTMLIFrameElement?.prototype;
  if (!proto) return;
  const desc = Object.getOwnPropertyDescriptor(proto, 'contentWindow');
  if (!desc?.get || !desc.configurable) return;
  const read = desc.get;
  Object.defineProperty(proto, 'contentWindow', {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      const frame = this as HTMLIFrameElement;
      const win = read.call(frame) as Page | null;
      const src = frame.src;
      if (win && (src === '' || src === 'about:blank')) install(win);
      return win;
    },
  });
}

function shortenSkipTimer(page: Page) {
  const original = page.setTimeout.bind(page);
  page.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
    let nativeTimer = false;
    try {
      nativeTimer = typeof handler === 'function' && handler.toString().includes('[native code]');
    } catch {
      nativeTimer = false;
    }
    if (enabled() && timeout === 17000 && nativeTimer) timeout = 17;
    return original(handler, timeout, ...(rest as []));
  }) as typeof page.setTimeout;
}

function neutralizeAbnormality(page: Page) {
  const original = page.Promise.prototype.then;
  page.Promise.prototype.then = function (
    this: Promise<unknown>,
    onFulfilled?: ((value: unknown) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ) {
    if (
      enabled() &&
      typeof onFulfilled === 'function' &&
      onFulfilled.toString().includes('onAbnormalityDetected')
    ) {
      onFulfilled = () => undefined;
    }
    return original.call(this, onFulfilled, onRejected);
  } as typeof original;
}

function watchPlayer(page: Page) {
  const tick = () => {
    if (!enabled()) {
      clearSpoof(page);
      return;
    }
    const videoId = new URLSearchParams(page.location.search).get('v') ?? '';
    if (videoId && videoId !== watchedVideo) {
      watchedVideo = videoId;
      remainingTokens = [...TOKENS];
      recovering = false;
    }
    skipScheduledAd();
    if (adblockWall()) recover(page);
    else if (originalUserAgent && !document.querySelector('.ad-showing')) {
      const video = document.querySelector('#movie_player video, .html5-video-player video');
      if (video instanceof HTMLVideoElement && !video.paused && video.currentTime > 8) clearSpoof(page);
    }
  };
  page.setInterval(tick, 500);
}

function skipScheduledAd() {
  const player = document.getElementById('movie_player') as YtPlayer | null;
  const stats = player?.getStatsForNerds?.();
  if (!stats?.debug_info?.startsWith('SSAP, AD')) return;
  const duration = player?.getProgressState?.()?.duration;
  if (typeof duration === 'number' && duration > 0) player?.seekTo?.(duration, true);
}

function adblockWall(): boolean {
  return Boolean(
    document.querySelector(
      '#player-error-message-container a[href*="support.google.com/youtube/answer/3037019"], #error-screen a[href*="support.google.com/youtube/answer/3037019"]',
    ),
  );
}

function recover(page: Page) {
  if (recovering) return;
  const player = document.getElementById('movie_player') as YtPlayer | null;
  const response = player?.getPlayerResponse?.();
  const videoId = response?.videoDetails?.videoId ?? new URLSearchParams(page.location.search).get('v');
  if (!player?.loadVideoById || !videoId) return;
  recovering = true;
  const token = remainingTokens.shift();
  if (token) applySpoof(page, token);
  else clearSpoof(page);
  const start = response?.playerConfig?.playbackStartConfig?.startSeconds ?? 0;
  player.loadVideoById(videoId, start);
  page.setTimeout(() => {
    recovering = false;
  }, 2500);
}

function applySpoof(page: Page, token: string) {
  const client = page.ytcfg?.data_?.INNERTUBE_CONTEXT?.client;
  if (!client?.userAgent) return;
  if (originalUserAgent === undefined) originalUserAgent = client.userAgent.replace(TOKEN_MARK, '').trim();
  const base = originalUserAgent.match(/Mozilla\/5\.0 \([^)]+/)?.[0] ?? originalUserAgent;
  client.userAgent = originalUserAgent.includes(base)
    ? originalUserAgent.replace(base, `${base}; ${token}`)
    : `${originalUserAgent}; ${token}`;
}

function clearSpoof(page: Page) {
  if (originalUserAgent === undefined) return;
  const client = page.ytcfg?.data_?.INNERTUBE_CONTEXT?.client;
  if (client) client.userAgent = originalUserAgent;
  originalUserAgent = undefined;
  remainingTokens = [...TOKENS];
}

// These fields are added only after a spoof token is already on the request.
// Ordinary watch requests do not carry one, so they are left alone.
function editOutbound(body: Outbound) {
  if (body.playabilityStatus || body.videoDetails || body.streamingData) return;
  const client = body.context?.client;
  if (!client?.userAgent) return;
  if (body.createCommentParams) {
    client.userAgent = client.userAgent.replace(TOKEN_MARK, '').replace(/\s{2,}/g, ' ').trim();
    return;
  }
  if (!body.attestationRequest) return;
  const ua = client.userAgent;
  if (ua.includes('channel') && client.clientName === 'WEB') client.clientScreen = 'CHANNEL';
  if (ua.includes('lactmilli')) body.params = '8AUB';
  if (ua.includes('yahi')) body.params = 'YAHI';
  const playback = body.playbackContext?.contentPlaybackContext;
  if (!playback) return;
  if (/channel|lactmilli|instream/.test(ua)) playback.lactMilliseconds = String(Date.now());
  if (
    typeof playback.referer === 'string' &&
    /adunit|channel|lactmilli|instream|inline|yahi|eafg/.test(ua)
  ) {
    playback.referer = playback.referer.replace(/(?:#reloadxhr)?$/, '#reloadxhr');
  }
}

function strip(root: unknown): unknown {
  walk(root, new Set<object>(), 0);
  return root;
}

function walk(node: unknown, seen: Set<object>, depth: number) {
  if (!node || typeof node !== 'object' || depth > 24 || seen.size > 50000 || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (let index = node.length - 1; index >= 0; index -= 1) {
      const item: unknown = node[index];
      if (isShortsAd(item)) {
        node.splice(index, 1);
        continue;
      }
      walk(item, seen, depth + 1);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  for (const key of AD_KEYS) {
    if (key in record) delete record[key];
  }
  if ('adBreakHeartbeatParams' in record) delete record.adBreakHeartbeatParams;
  const config = record.playerConfig;
  if (config && typeof config === 'object') {
    const playerConfig = config as Record<string, unknown>;
    if ('adPlacementConfig' in playerConfig) delete playerConfig.adPlacementConfig;
    if ('adSignalsConfig' in playerConfig) delete playerConfig.adSignalsConfig;
  }
  for (const key of Object.keys(record)) walk(record[key], seen, depth + 1);
}

function isShortsAd(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const params = (value as { adClientParams?: { isAd?: boolean } }).adClientParams;
  return params?.isAd === true;
}
