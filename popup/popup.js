// Auto MP4 Downloader — popup

const DEFAULTS = {
  enabled: false,
  subfolder: "AutoMP4",
  recent: [],
};

const enabledEl = document.getElementById("enabled");
const subfolderEl = document.getElementById("subfolder");
const recentEl = document.getElementById("recent");

const STATE_LABEL = {
  complete: "완료",
  failed: "실패",
  in_progress: "저장 중…",
};

function render(state) {
  enabledEl.checked = !!state.enabled;
  // 포커스/편집 중이 아닐 때만 서브폴더 값 갱신
  if (document.activeElement !== subfolderEl) {
    subfolderEl.value = state.subfolder ?? DEFAULTS.subfolder;
  }
  renderRecent(state.recent || []);
}

function renderRecent(recent) {
  recentEl.innerHTML = "";
  if (!recent.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "아직 없음";
    recentEl.appendChild(li);
    return;
  }
  for (const r of recent) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "fname";
    name.textContent = r.name || "(이름 없음)";
    name.title = r.error ? `${r.name}\n${r.error}` : r.name || "";

    const state = document.createElement("span");
    const key = r.state || "in_progress";
    state.className = `state ${key}`;
    state.textContent = STATE_LABEL[key] || key;

    li.append(name, state);
    recentEl.appendChild(li);
  }
}

async function load() {
  const state = await chrome.storage.local.get(DEFAULTS);
  render({ ...DEFAULTS, ...state });
}

enabledEl.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: enabledEl.checked });
});

// 서브폴더는 sanitize 후 저장 (입력 종료 시)
function saveSubfolder() {
  const raw = subfolderEl.value;
  chrome.storage.local.set({ subfolder: raw });
}
subfolderEl.addEventListener("change", saveSubfolder);
subfolderEl.addEventListener("blur", saveSubfolder);

// storage 변경을 팝업에 실시간 반영 (다운로드 진행/완료 등)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  load();
});

load();
