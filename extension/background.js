/**
 * background.js — Service Worker
 *
 * Responsibilities:
 * 1) Keep toolbar badge showing open real-web tab count
 * 2) Track tab-level active time (focus duration) locally in chrome.storage
 */

const ACTIVITY_STORAGE_KEY = 'tabActivityV1';
const ACTIVITY_SCHEMA_VERSION = 1;

function createDefaultActivityState() {
  return {
    schemaVersion: ACTIVITY_SCHEMA_VERSION,
    byUrl: {},
    currentSession: null,
    updatedAt: Date.now(),
  };
}

function isTrackableUrl(url) {
  if (!url) return false;
  return (
    !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('about:') &&
    !url.startsWith('edge://') &&
    !url.startsWith('brave://')
  );
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url || '';
  }
}

async function loadActivityState() {
  try {
    const data = await chrome.storage.local.get(ACTIVITY_STORAGE_KEY);
    const state = data[ACTIVITY_STORAGE_KEY];
    if (!state || typeof state !== 'object') return createDefaultActivityState();
    if (state.schemaVersion !== ACTIVITY_SCHEMA_VERSION) return createDefaultActivityState();
    if (!state.byUrl || typeof state.byUrl !== 'object') state.byUrl = {};
    return state;
  } catch {
    return createDefaultActivityState();
  }
}

async function saveActivityState(state) {
  state.updatedAt = Date.now();
  await chrome.storage.local.set({ [ACTIVITY_STORAGE_KEY]: state });
}

function ensureUrlEntry(state, normalizedUrl) {
  if (!state.byUrl[normalizedUrl]) {
    state.byUrl[normalizedUrl] = {
      totalActiveMs: 0,
      sessions: 0,
      lastActiveAt: null,
    };
  }
  return state.byUrl[normalizedUrl];
}

async function flushCurrentSession() {
  const state = await loadActivityState();
  const current = state.currentSession;
  if (!current) return;

  const now = Date.now();
  const elapsedMs = Math.max(0, now - (current.startedAt || now));
  if (elapsedMs > 0 && current.normalizedUrl) {
    const entry = ensureUrlEntry(state, current.normalizedUrl);
    entry.totalActiveMs += elapsedMs;
    entry.sessions += 1;
    entry.lastActiveAt = now;
  }

  state.currentSession = null;
  await saveActivityState(state);
}

async function startSessionForTab(tab) {
  const state = await loadActivityState();

  if (!tab || !isTrackableUrl(tab.url)) {
    if (state.currentSession) {
      state.currentSession = null;
      await saveActivityState(state);
    }
    return;
  }

  const normalizedUrl = normalizeUrl(tab.url);
  const current = state.currentSession;

  if (
    current &&
    current.tabId === tab.id &&
    current.windowId === tab.windowId &&
    current.normalizedUrl === normalizedUrl
  ) {
    return;
  }

  state.currentSession = {
    tabId: tab.id,
    windowId: tab.windowId,
    normalizedUrl,
    startedAt: Date.now(),
  };
  await saveActivityState(state);
}

async function trackActiveTabInWindow(windowId) {
  if (typeof windowId !== 'number' || windowId < 0) {
    await flushCurrentSession();
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, windowId });
  const activeTab = tabs[0];
  await flushCurrentSession();
  await startSessionForTab(activeTab);
}

async function initializeTrackingFromFocusedWindow() {
  try {
    const focused = await chrome.windows.getLastFocused({ populate: true });
    const activeTab = (focused.tabs || []).find(tab => tab.active);
    await startSessionForTab(activeTab);
  } catch {
    await startSessionForTab(null);
  }
}

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  initializeTrackingFromFocusedWindow();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  initializeTrackingFromFocusedWindow();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  updateBadge();
  void (async () => {
    const state = await loadActivityState();
    if (state.currentSession && state.currentSession.tabId === tabId) {
      await flushCurrentSession();
    }
  })();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  updateBadge();
  if (!changeInfo.url) return;
  void (async () => {
    const state = await loadActivityState();
    const current = state.currentSession;
    if (!current || current.tabId !== tabId) return;

    await flushCurrentSession();
    await startSessionForTab(tab);
  })();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void trackActiveTabInWindow(activeInfo.windowId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    void flushCurrentSession();
    return;
  }
  void trackActiveTabInWindow(windowId);
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
initializeTrackingFromFocusedWindow();
