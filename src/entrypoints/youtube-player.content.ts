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
      INNERTUBE_API_KEY?: string;
      STS?: number;
      INNERTUBE_CONTEXT?: {
        client?: { userAgent?: string; clientName?: string; clientVersion?: string; clientScreen?: string };
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

type ErrorScreen = {
  playerErrorMessageRenderer?: {
    playerCaptchaViewModel?: unknown;
    subreason?: { runs?: unknown };
  };
  playerInterstitialRenderer?: {
    content?: {
      interstitialViewModel?: {
        description?: { commandRuns?: unknown };
      };
    };
  };
};

type PlayerResponse = {
  videoDetails?: { videoId?: string };
  playabilityStatus?: { status?: string; reason?: string; errorScreen?: ErrorScreen };
  playerConfig?: { playbackStartConfig?: { startSeconds?: number } };
};

type Outbound = {
  videoId?: string;
  contentCheckOk?: boolean;
  racyCheckOk?: boolean;
  attestationRequest?: unknown;
  createCommentParams?: unknown;
  playabilityStatus?: unknown;
  videoDetails?: unknown;
  streamingData?: unknown;
  params?: string;
  context?: {
    client?: { userAgent?: string; clientName?: string; clientVersion?: string; clientScreen?: string };
  };
  playbackContext?: {
    contentPlaybackContext?: {
      lactMilliseconds?: string;
      referer?: string;
      isInlinePlaybackNoAd?: boolean;
    };
  };
};

const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];
const TOKENS = ['channel', 'lactmilli', 'yahi', 'inline'];
const TOKEN_MARK = /(?:^|;\s*)(?:adunit|channel|lactmilli|instream|inline|yahi|eafg|yaf4)\b/;
const SUPPORT_ARTICLE = 'support.google.com/youtube/answer/3037019';

const WALL_NODES =
  '#error-screen, #player-error-message-container, .ytp-error, ytd-enforcement-message-view-model, yt-playability-error-supported-renderers, .ytdEnforcementMessageViewModelHost';

const TOKEN_KEY = 'block-yt-token';

let originalUserAgent: string | undefined;
let activeToken: string | null = null;
let remainingTokens = [...TOKENS];
let gaveUp = false;
let watchedVideo = '';
let attemptAt = 0;
let attemptGen = 0;
let playerRequestPending = false;
let playerRequestSeen = false;
let settleUntil = 0;
let nativeFetch: typeof window.fetch | null = null;
let cachedPlayable: { videoId: string; body: string } | null = null;
const prefetching = new Map<string, Promise<PlayerResponse | null>>();
const prefetchState = new Map<string, 'running' | 'done'>();

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
  if (page[HOOK]) return;
  page[HOOK] = true;
  try {
    hookJson(page);
    hookFetch(page);
    hookXhr(page);
    if (!isTop(page)) return;
    trapPlayerResponse(page);
    watchForConfig(page);
    blockCleanRealm(page);
    shortenSkipTimer(page);
    neutralizeAbnormality(page);
  } catch {
    // A cross-origin frame cannot be hooked. The top page still is.
  }
  if (isTop(page)) watchPlayer(page);
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
  nativeFetch = original;
  page.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = requestUrl(input);
    const cached = cachedPlayableResponse(url, init);
    if (cached) {
      const gen = watchPlayability();
      return Promise.resolve(cleanResponse(page, cached)).finally(() => finishPlayability(gen));
    }
    let nextInput = input;
    let nextInit = init;
    if (enabled() && activeToken && carriesPlayability(url) && typeof init?.body === 'string') {
      nextInit = { ...init, body: rewritePlayerBody(init.body) };
    }
    const pending = original(nextInput, nextInit);
    if (!enabled() || !isPlayerCall(requestUrl(nextInput))) return pending;
    const gen = carriesPlayability(url) ? watchPlayability() : 0;
    return pending.then((response) => cleanResponse(page, response)).finally(() => finishPlayability(gen));
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
  try {
    hookXhrSend(proto);
  } catch {
    // Response cleaning still works when the request body cannot be rewritten.
  }
}

const xhrUrls = new WeakMap<XMLHttpRequest, string>();

function hookXhrSend(proto: typeof XMLHttpRequest.prototype) {
  const open = proto.open;
  const send = proto.send;
  proto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    xhrUrls.set(this, typeof url === 'string' ? url : url.href);
    return open.call(this, method, url, async ?? true, username, password);
  };
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = xhrUrls.get(this) ?? '';
    if (enabled() && activeToken && carriesPlayability(url) && typeof body === 'string') {
      body = rewritePlayerBody(body);
    }
    const gen = enabled() && carriesPlayability(url) ? watchPlayability() : 0;
    if (gen !== 0) {
      const done = () => {
        if (this.readyState !== 4) return;
        this.removeEventListener('readystatechange', done);
        finishPlayability(gen);
      };
      this.addEventListener('readystatechange', done);
    }
    return send.call(this, body);
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isPlayerCall(url: string): boolean {
  return carriesPlayability(url) || url.includes('/youtubei/v1/next') || url.includes('/youtubei/v1/reel/') || url.includes('/resolve_url') || url.includes('playlist?');
}

function carriesPlayability(url: string): boolean {
  return /\/player(?:\?|$)/.test(url) || url.includes('/get_watch');
}

function preferredOrder(): string[] {
  let saved = '';
  try {
    saved = sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    saved = '';
  }
  if (!TOKENS.includes(saved)) return [...TOKENS];
  return [saved, ...TOKENS.filter((token) => token !== saved)];
}

function rememberWorkingToken() {
  if (!activeToken || !TOKENS.includes(activeToken)) return;
  try {
    sessionStorage.setItem(TOKEN_KEY, activeToken);
  } catch {
    // Private mode can block session storage. This video already has the token.
  }
}

function watchPlayability(): number {
  if (attemptGen === 0) return 0;
  playerRequestSeen = true;
  playerRequestPending = true;
  return attemptGen;
}

function finishPlayability(gen: number) {
  if (gen === 0 || gen !== attemptGen) return;
  playerRequestPending = false;
  settleUntil = Date.now() + 250;
}

function canAttempt(): boolean {
  if (gaveUp) return false;
  if (attemptAt === 0) return true;
  if (Date.now() < settleUntil) return false;
  const elapsed = Date.now() - attemptAt;
  if (playerRequestPending) return elapsed > 1200;
  if (playerRequestSeen) return true;
  return elapsed > 450;
}

function rewritePlayerBody(body: string): string {
  if (!activeToken) return body;
  try {
    const value = JSON.parse(body) as Outbound;
    ensureToken(value, activeToken);
    return JSON.stringify(value);
  } catch {
    return body;
  }
}

function ensureToken(body: Outbound, token: string) {
  const client = body.context?.client;
  if (!client) return;
  const cleaned = (client.userAgent ?? '')
    .replace(/(?:^|;\s*)(?:adunit|channel|lactmilli|instream|inline|yahi|eafg|yaf4)\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const base = cleaned.match(/Mozilla\/5\.0 \([^)]+/)?.[0];
  client.userAgent =
    base && cleaned.includes(base) ? cleaned.replace(base, `${base}; ${token}`) : `${cleaned}; ${token}`;
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
        const next = enabled() ? strip(value) : value;
        if (enabled() && cachedPlayable && isAdblockResponse(next as PlayerResponse)) {
          current = page.JSON.parse(cachedPlayable.body) as PlayerResponse;
          return;
        }
        current = next;
        if (enabled() && isAdblockResponse(next as PlayerResponse)) startPrefetch(page);
      },
    });
  } catch {
    if (current && enabled()) strip(current);
    return;
  }
  if (current && enabled()) {
    current = strip(current);
    if (isAdblockResponse(current as PlayerResponse)) startPrefetch(page);
  }
}

function watchForConfig(page: Page) {
  const videoId = new URLSearchParams(page.location.search).get('v');
  if (!videoId) return;
  const [token] = preferredOrder();
  if (token) activeToken = token;
  const timer = page.setInterval(() => {
    if (!enabled() || prefetching.has(videoId)) {
      page.clearInterval(timer);
      return;
    }
    if (!page.ytcfg?.data_?.INNERTUBE_API_KEY || !page.ytcfg.data_.INNERTUBE_CONTEXT?.client) return;
    if (activeToken) applySpoof(page, activeToken);
    startPrefetch(page);
    page.clearInterval(timer);
  }, 15);
}

function startPrefetch(page: Page) {
  const videoId = new URLSearchParams(page.location.search).get('v');
  const token = activeToken ?? preferredOrder()[0];
  if (!videoId || !token || !page.ytcfg?.data_?.INNERTUBE_API_KEY) return;
  if (!activeToken) activeToken = token;
  void prefetchPlayable(page, videoId, token);
}

function prefetchPlayable(page: Page, videoId: string, token: string): Promise<PlayerResponse | null> {
  const existing = prefetching.get(videoId);
  if (existing) return existing;
  prefetchState.set(videoId, 'running');
  const pending = runPrefetch(page, videoId, token).finally(() => {
    prefetchState.set(videoId, 'done');
  });
  prefetching.set(videoId, pending);
  return pending;
}

async function runPrefetch(page: Page, videoId: string, token: string): Promise<PlayerResponse | null> {
  if (!enabled()) return null;
  activeToken = token;
  applySpoof(page, token);
  const result = await requestPlayable(page, videoId, token);
  if (!result) return null;
  cachedPlayable = { videoId, body: page.JSON.stringify(result) };
  rememberWorkingToken();
  publishPlayable(page, videoId, result);
  return result;
}

async function requestPlayable(page: Page, videoId: string, token: string): Promise<PlayerResponse | null> {
  const data = page.ytcfg?.data_;
  const key = data?.INNERTUBE_API_KEY;
  const context = data?.INNERTUBE_CONTEXT;
  if (!nativeFetch || !key || !context?.client?.userAgent) return null;
  const body: Outbound = {
    videoId,
    context: { client: { ...context.client } },
    playbackContext: {
      contentPlaybackContext: {
        lactMilliseconds: String(Date.now()),
        referer: `${page.location.href.replace(/#.*$/, '')}#reloadxhr`,
      },
    },
    attestationRequest: { omitBotguardData: true },
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const playback = body.playbackContext?.contentPlaybackContext as { signatureTimestamp?: number } | undefined;
  if (playback && typeof data.STS === 'number') playback.signatureTimestamp = data.STS;
  ensureToken(body, token);
  editOutbound(body);
  try {
    const response = await nativeFetch(`/youtubei/v1/player?prettyPrint=false&key=${encodeURIComponent(key)}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-youtube-client-name': '1',
        'x-youtube-client-version': context.client.clientVersion ?? '',
      },
      body: page.JSON.stringify(body),
    });
    if (!response.ok) return null;
    const parsed = page.JSON.parse(await response.text()) as PlayerResponse;
    return isPlayable(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlayable(response: PlayerResponse): boolean {
  if (isAdblockResponse(response)) return false;
  const status = response.playabilityStatus?.status;
  if (status === 'UNPLAYABLE' || status === 'ERROR' || status === 'LOGIN_REQUIRED') return false;
  return status === 'OK' || !!response.streamingData;
}

function publishPlayable(page: Page, videoId: string, result: PlayerResponse) {
  const initial = page.ytInitialPlayerResponse as PlayerResponse | undefined;
  if (!initial || isAdblockResponse(initial)) page.ytInitialPlayerResponse = result;
  const player = findPlayer();
  if (!player?.loadVideoById || playingVideo(player)) return;
  const current = player.getPlayerResponse?.();
  if (current && !isAdblockResponse(current)) return;
  player.loadVideoById(videoId, startSeconds(page, result));
}

function cachedPlayableResponse(url: string, init?: RequestInit): Response | null {
  if (!cachedPlayable || !carriesPlayability(url) || typeof init?.body !== 'string') return null;
  if (videoIdIn(init.body) !== cachedPlayable.videoId) return null;
  return new Response(cachedPlayable.body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function videoIdIn(body: string): string {
  try {
    const parsed = JSON.parse(body) as { videoId?: string };
    return typeof parsed.videoId === 'string' ? parsed.videoId : '';
  } catch {
    return '';
  }
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
      remainingTokens = preferredOrder();
      gaveUp = false;
      attemptAt = 0;
      attemptGen = 0;
      playerRequestPending = false;
      playerRequestSeen = false;
      settleUntil = 0;
      const token = remainingTokens[0];
      if (token) {
        activeToken = token;
        applySpoof(page, token);
        startPrefetch(page);
      }
    }
    const player = findPlayer();
    skipScheduledAd(player);
    dismissInterruptions();
    if (adblockWall(player)) {
      if (revealPlayback(player)) return;
      recover(page, player);
      return;
    }
    const video = player?.querySelector('video') ?? document.querySelector('.html5-video-player video');
    if (video instanceof HTMLVideoElement && !video.paused && video.currentTime > 1) {
      gaveUp = false;
      rememberWorkingToken();
    }
  };
  tick();
  page.setInterval(tick, 100);
}

function skipScheduledAd(player: YtPlayer | null) {
  const stats = player?.getStatsForNerds?.();
  if (!stats?.debug_info?.startsWith('SSAP, AD')) return;
  const duration = player?.getProgressState?.()?.duration;
  if (typeof duration === 'number' && duration > 0) player?.seekTo?.(duration, true);
}

function adblockWall(player: YtPlayer | null): boolean {
  if (isAdblockResponse(player?.getPlayerResponse?.())) return true;
  return visibleWall();
}

function visibleWall(): boolean {
  for (const node of document.querySelectorAll(WALL_NODES)) {
    if (!isShown(node)) continue;
    if (hasWallCopy(node.textContent ?? '')) return true;
    const shadow = node.shadowRoot;
    if (!shadow) continue;
    if (hasWallCopy(shadow.textContent ?? '')) return true;
    for (const inner of shadow.querySelectorAll('*')) {
      const nested = inner.shadowRoot;
      if (nested && hasWallCopy(nested.textContent ?? '')) return true;
    }
  }
  return false;
}

function isShown(node: Element): boolean {
  if (!(node instanceof HTMLElement)) return true;
  const style = getComputedStyle(node);
  return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
}

function isAdblockResponse(response: PlayerResponse | undefined): boolean {
  const status = response?.playabilityStatus;
  if (status?.status !== 'UNPLAYABLE' && status?.status !== 'ERROR') return false;
  const screen = status.errorScreen;
  if (!screen || screen.playerErrorMessageRenderer?.playerCaptchaViewModel) return false;
  const blob = `${status.reason ?? ''}\n${JSON.stringify(screen)}`;
  if (blob.includes('WEB_PAGE_TYPE_UNKNOWN') && blob.includes(SUPPORT_ARTICLE)) return true;
  return hasWallCopy(blob);
}

const REVEAL_STYLE_ID = 'block-youtube-reveal';

function revealPlayback(player: YtPlayer | null): boolean {
  const video = playingVideo(player);
  if (!video) return false;
  // The picture is covered, but the element is already playing. Reloading would
  // start the wall over. Take the cover off instead.
  player?.classList.remove('ytp-error');
  player?.classList.add('block-reveal');
  rememberWorkingToken();
  ensureRevealStyle();
  removeWall(player);
  const container = video.closest('.html5-video-container');
  for (const el of [container, video]) {
    if (!(el instanceof HTMLElement)) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none') el.style.setProperty('display', 'block', 'important');
    if (style.visibility === 'hidden') el.style.setProperty('visibility', 'visible', 'important');
    if (style.opacity === '0') el.style.setProperty('opacity', '1', 'important');
  }
  return true;
}

function playingVideo(player: YtPlayer | null): HTMLVideoElement | null {
  const nodes = player?.querySelectorAll('video') ?? document.querySelectorAll('#movie_player video');
  for (const node of nodes) {
    if (!(node instanceof HTMLVideoElement)) continue;
    if (!node.paused && (node.currentTime > 0 || node.readyState >= 2)) return node;
  }
  return null;
}

function removeWall(player: YtPlayer | null) {
  const scopes: ParentNode[] = [document];
  if (player) scopes.unshift(player);
  const seen = new Set<Element>();
  for (const scope of scopes) {
    for (const node of scope.querySelectorAll(WALL_NODES)) {
      if (seen.has(node)) continue;
      seen.add(node);
      const text = `${node.textContent ?? ''}\n${node.shadowRoot?.textContent ?? ''}`;
      if (!hasWallCopy(text)) continue;
      if (node instanceof HTMLElement) node.style.setProperty('display', 'none', 'important');
      node.remove();
    }
  }
}

function ensureRevealStyle() {
  if (document.getElementById(REVEAL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = REVEAL_STYLE_ID;
  style.textContent = [
    '#movie_player.block-reveal .html5-video-container,',
    '#movie_player.block-reveal video.html5-main-video {',
    '  display: block !important;',
    '  visibility: visible !important;',
    '  opacity: 1 !important;',
    '}',
    '#movie_player.block-reveal #error-screen,',
    '#movie_player.block-reveal ytd-enforcement-message-view-model,',
    '#movie_player.block-reveal yt-playability-error-supported-renderers {',
    '  display: none !important;',
    '}',
  ].join('\n');
  (document.documentElement ?? document.head).append(style);
}

function dismissInterruptions() {
  const hosts: HTMLElement[] = [];
  const player = document.getElementById('movie_player');
  const box = document.getElementById('player');
  if (player) hosts.push(player);
  if (box && box !== player) hosts.push(box);
  for (const popup of document.querySelectorAll('ytd-popup-container, tp-yt-paper-dialog, .ytp-suggested-action-popup')) {
    if (popup instanceof HTMLElement) hosts.push(popup);
  }
  for (const host of hosts) {
    if (!(host.textContent ?? '').includes('Experiencing interruptions')) continue;
    const target = interruptionCard(host);
    if (!target || target === host) continue;
    target
      .querySelector<HTMLElement>(
        'button[aria-label="Close"], button[aria-label="Dismiss"], .ytp-suggested-action-badge-dismiss',
      )
      ?.click();
    target.remove();
  }
}

function interruptionCard(host: HTMLElement): HTMLElement | null {
  const seed = smallestWithText(host, 'Experiencing interruptions');
  if (!seed || seed === host) return null;
  let card = seed;
  let parent = seed.parentElement;
  while (parent && parent !== host && parent !== document.body) {
    const text = parent.textContent ?? '';
    if (!text.includes('Experiencing interruptions') || text.length > 500) break;
    card = parent;
    parent = parent.parentElement;
  }
  return card;
}

function smallestWithText(root: HTMLElement, phrase: string): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLength = Infinity;
  for (const node of root.querySelectorAll<HTMLElement>('*')) {
    const text = node.textContent ?? '';
    if (!text.includes(phrase) || text.length > 500 || text.length >= bestLength) continue;
    best = node;
    bestLength = text.length;
  }
  return best;
}

function hasWallCopy(text: string): boolean {
  return text.includes('Allow YouTube Ads') || /Ad blockers violate YouTube['’]s Terms of Service/.test(text);
}

function startSeconds(page: Page, response: PlayerResponse | undefined): number {
  const configured = response?.playerConfig?.playbackStartConfig?.startSeconds;
  if (typeof configured === 'number' && configured > 0) return configured;
  const raw = new URLSearchParams(page.location.search).get('t');
  if (!raw) return 0;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

type YtdPlayerHost = HTMLElement & {
  player_?: YtPlayer;
  getPlayer?: () => YtPlayer | undefined;
};

function findPlayer(): YtPlayer | null {
  const direct = document.getElementById('movie_player') as YtPlayer | null;
  if (direct?.loadVideoById) return direct;
  const host = document.querySelector('ytd-player') as YtdPlayerHost | null;
  const inner = host?.getPlayer?.() ?? host?.player_;
  if (inner?.loadVideoById) return inner;
  return direct;
}

function recover(page: Page, player: YtPlayer | null) {
  if (!canAttempt()) return;
  const target = player?.loadVideoById ? player : findPlayer();
  if (!target?.loadVideoById) return;
  const response = target.getPlayerResponse?.();
  const videoId = response?.videoDetails?.videoId ?? new URLSearchParams(page.location.search).get('v');
  if (!videoId) return;
  if (prefetchState.get(videoId) === 'running') return;
  const token = remainingTokens[0];
  if (token) {
    activeToken = token;
    applySpoof(page, token);
    remainingTokens.shift();
  } else {
    clearSpoof(page);
    gaveUp = true;
  }
  attemptGen += 1;
  attemptAt = Date.now();
  playerRequestPending = false;
  playerRequestSeen = false;
  target.loadVideoById(videoId, startSeconds(page, response));
}

function applySpoof(page: Page, token: string): boolean {
  const client = page.ytcfg?.data_?.INNERTUBE_CONTEXT?.client;
  if (!client?.userAgent) return false;
  if (originalUserAgent === undefined) originalUserAgent = client.userAgent.replace(TOKEN_MARK, '').trim();
  const base = originalUserAgent.match(/Mozilla\/5\.0 \([^)]+/)?.[0] ?? originalUserAgent;
  client.userAgent = originalUserAgent.includes(base)
    ? originalUserAgent.replace(base, `${base}; ${token}`)
    : `${originalUserAgent}; ${token}`;
  return true;
}

function clearSpoof(page: Page) {
  activeToken = null;
  if (originalUserAgent === undefined) return;
  const client = page.ytcfg?.data_?.INNERTUBE_CONTEXT?.client;
  if (client) client.userAgent = originalUserAgent;
  originalUserAgent = undefined;
  remainingTokens = preferredOrder();
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
  if (ua.includes('inline')) playback.isInlinePlaybackNoAd = true;
  if (/channel|lactmilli|inline|instream/.test(ua)) playback.lactMilliseconds = String(Date.now());
  if (
    typeof playback.referer === 'string' &&
    /adunit|channel|lactmilli|instream|inline|yahi|eafg|yaf4/.test(ua)
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
  const messages = record.messageRenderers;
  if (messages && typeof messages === 'object' && 'enforcementMessageViewModel' in messages) {
    delete (messages as Record<string, unknown>).enforcementMessageViewModel;
  }
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
