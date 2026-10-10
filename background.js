// Auto MP4 Downloader — background service worker (MV3)
// 헤더 기반 감지 + dedup + 다운로드 트리거

const DEFAULTS = {
  enabled: false,
  subfolder: "AutoMP4",
  recent: [],
};

const THRESHOLD = 5 * 1024 * 1024; // 5MB. 숏폼 대상이면 2MB로 낮출 것.
const MAX_RECENT = 10;

// SW 재시작에 대비해 세션 스토리지에 미러링하는 in-memory 캐시
let seen = new Set();

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------

async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

async function loadSeen() {
  try {
    const { seen: stored } = await chrome.storage.session.get({ seen: [] });
    seen = new Set(stored);
  } catch (e) {
    seen = new Set();
  }
}

async function persistSeen() {
  try {
    await chrome.storage.session.set({ seen: [...seen] });
  } catch (e) {
    // session storage 미지원/에러는 무시 (in-memory로만 동작)
  }
}

// 확장 로드/재시작 시 seen 복원
loadSeen();

// ---------------------------------------------------------------------------
// badge
// ---------------------------------------------------------------------------

async function refreshBadge() {
  const { enabled } = await getSettings();
  await chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
  if (enabled) {
    await chrome.action.setBadgeBackgroundColor({ color: "#1a7f37" });
  }
}

refreshBadge();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) {
    refreshBadge();
  }
});

// ---------------------------------------------------------------------------
// URL 정규화 & dedup 키
// ---------------------------------------------------------------------------

// 서명(토큰) 쿼리가 붙어 있으면 서명 URL로 간주 → 전체 URL을 키로.
// 아니면 origin + pathname 으로 dedup (Range 등 재요청 흡수).
const SIGNATURE_HINTS = [
  "signature", "sig", "token", "expires", "expire", "x-amz-",
  "policy", "key-pair-id", "hmac", "st=", "e=", "hash",
];

function looksSigned(searchParams, rawSearch) {
  const lower = rawSearch.toLowerCase();
  for (const hint of SIGNATURE_HINTS) {
    if (lower.includes(hint)) return true;
  }
  return false;
}

function dedupKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (looksSigned(u.searchParams, u.search)) {
      // 인증 토큰 유지: 프래그먼트만 제거
      u.hash = "";
      return u.toString();
    }
    return u.origin + u.pathname;
  } catch (e) {
    return rawUrl;
  }
}

// ---------------------------------------------------------------------------
// 감지 판정
// ---------------------------------------------------------------------------

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === target) return h.value || "";
  }
  return undefined;
}

function isMp4ByType(contentType) {
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith("video/mp4");
}

function isMp4ByUrl(rawUrl) {
  try {
    const path = new URL(rawUrl).pathname.toLowerCase();
    return path.endsWith(".mp4");
  } catch (e) {
    return false;
  }
}

function passesSizeGate(contentLength) {
  // 헤더 없음(chunked 등) → 통과 처리. type/URL로만 판단.
  if (contentLength === undefined) return true;
  const n = Number(contentLength);
  if (!Number.isFinite(n)) return true;
  return n >= THRESHOLD;
}

// ---------------------------------------------------------------------------
// 파일명 유도
// ---------------------------------------------------------------------------

function parseContentDispositionFilename(cd) {
  if (!cd) return undefined;
  // filename*=UTF-8''... 우선
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(cd);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch (e) {
      return star[1].trim();
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (plain && plain[1]) return plain[1].trim();
  return undefined;
}

function filenameFromUrl(rawUrl) {
  try {
    const path = new URL(rawUrl).pathname;
    const seg = decodeURIComponent(path.split("/").filter(Boolean).pop() || "");
    return seg || undefined;
  } catch (e) {
    return undefined;
  }
}

function sanitizeFilename(name) {
  let n = (name || "").trim();
  // 경로 구분자 및 OS 금지문자 제거
  n = n.replace(/[\\/:*?"<>|]/g, "_");
  n = n.replace(/\.\.+/g, "_");
  n = n.replace(/[\x00-\x1f]/g, "");
  n = n.replace(/^\.+/, ""); // 선행 점 제거
  n = n.trim();
  if (!n) return "";
  if (!/\.mp4$/i.test(n)) n += ".mp4";
  return n;
}

function deriveFilename(rawUrl, headers) {
  const cd = headerValue(headers, "content-disposition");
  const fromCd = sanitizeFilename(parseContentDispositionFilename(cd) || "");
  if (fromCd) return fromCd;

  const fromUrl = sanitizeFilename(filenameFromUrl(rawUrl) || "");
  if (fromUrl) return fromUrl;

  return `video_${Date.now()}.mp4`;
}

function sanitizeSubfolder(sub) {
  let s = (sub || "").trim();
  s = s.replace(/[\\/]+/g, "/"); // 백슬래시 → 슬래시
  s = s
    .split("/")
    .map((seg) =>
      seg
        .replace(/[:*?"<>|]/g, "_")
        .replace(/\.\.+/g, "_")
        .replace(/^\.+/, "")
        .trim()
    )
    .filter(Boolean)
    .join("/");
  return s || DEFAULTS.subfolder;
}

// ---------------------------------------------------------------------------
// recent 목록
// ---------------------------------------------------------------------------

async function addRecent(entry) {
  const { recent } = await getSettings();
  const next = [entry, ...recent].slice(0, MAX_RECENT);
  await chrome.storage.local.set({ recent: next });
}

async function updateRecentByDownloadId(downloadId, patch) {
  const { recent } = await getSettings();
  let changed = false;
  const next = recent.map((r) => {
    if (r.downloadId === downloadId) {
      changed = true;
      return { ...r, ...patch };
    }
    return r;
  });
  if (changed) await chrome.storage.local.set({ recent: next });
}

// ---------------------------------------------------------------------------
// 다운로드 트리거
// ---------------------------------------------------------------------------

async function triggerDownload(rawUrl, headers) {
  const { subfolder } = await getSettings();
  const safeSub = sanitizeSubfolder(subfolder);
  const safeName = deriveFilename(rawUrl, headers);
  const filename = `${safeSub}/${safeName}`;

  chrome.downloads.download(
    {
      url: rawUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    },
    async (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        await addRecent({
          name: safeName,
          state: "failed",
          error: chrome.runtime.lastError?.message || "download start failed",
          ts: Date.now(),
        });
        return;
      }
      await addRecent({
        name: safeName,
        state: "in_progress",
        downloadId,
        ts: Date.now(),
      });
    }
  );
}

// ---------------------------------------------------------------------------
// onHeadersReceived 리스너 (관찰 전용)
// ---------------------------------------------------------------------------

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // 리스너는 항상 붙어있되 enabled 게이트
    handleHeaders(details).catch(() => {});
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

async function handleHeaders(details) {
  const { enabled } = await getSettings();
  if (!enabled) return;

  const headers = details.responseHeaders || [];
  const contentType = headerValue(headers, "content-type");
  const contentLength = headerValue(headers, "content-length");

  const typeOk = isMp4ByType(contentType) || isMp4ByUrl(details.url);
  if (!typeOk) return;
  if (!passesSizeGate(contentLength)) return;

  const key = dedupKey(details.url);
  if (seen.has(key)) return;
  seen.add(key);
  persistSeen();

  await triggerDownload(details.url, headers);
}

// ---------------------------------------------------------------------------
// 다운로드 결과 추적
// ---------------------------------------------------------------------------

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const state = delta.state.current;
  if (state === "complete") {
    await updateRecentByDownloadId(delta.id, { state: "complete" });
  } else if (state === "interrupted") {
    await updateRecentByDownloadId(delta.id, {
      state: "failed",
      error: delta.error?.current || "interrupted",
    });
  }
});
