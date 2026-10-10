# CLAUDE.md — Auto MP4 Downloader (Chrome Extension, MV3)

## 목적
활성화 상태에서, 어느 탭에서든 **직접 mp4 파일**(단일 URL, `video/mp4`)을 받는 영상이 감지되면
자동으로 `Downloads/<서브폴더>/` 에 전체 저장하는 크롬 확장.

- 대상: **직접 파일 케이스만** (`.mp4` 단일 URL). HLS/DASH(`.m3u8`/`.mpd`)·DRM은 범위 밖.
- 저장소: `chrome.downloads` API. 저장 경로는 `Downloads/` 하위 서브폴더로 고정(임의 절대경로 미지원 — 의도된 트레이드오프).

## 비목표 (Non-goals)
- HLS/DASH 세그먼트 머지 (별도 프로젝트)
- DRM(Widevine/FairPlay/EME) 우회 — 원리적으로 불가, 시도하지 말 것
- `blob:` src 처리 (MSE 스트리밍) — 감지에서 제외

---

## UI 스펙 (popup)
- **활성화/비활성화 토글** (기본: 비활성화)
  - 상태는 `chrome.storage.local`에 `{ enabled: boolean }`으로 영속화
- **서브폴더 이름 입력** (선택, 기본값 `AutoMP4`)
  - 예: `AutoMP4` → `Downloads/AutoMP4/파일.mp4`
  - 입력값은 sanitize (경로 구분자·`..`·금지문자 제거)
- **최근 다운로드 목록** (최대 10개, 파일명 + 상태)
- 상태 뱃지: 활성화 시 action icon에 `ON` badge 표시

> 디렉토리 피커(FSA `showDirectoryPicker`)는 **쓰지 않는다.** UI를 띄우지 않는 게 이 설계의 핵심.

---

## 아키텍처 (MV3)

```
manifest.json          # MV3, permissions 최소화
background (SW)         # 감지 + dedup + 다운로드 트리거
popup/                  # 토글, 서브폴더 설정, 최근 목록
  popup.html
  popup.js
storage                 # chrome.storage.local: enabled, subfolder, recent[]
```

- **offscreen document 불필요** (FSA 안 쓰므로)
- **content script 불필요** (헤더 기반 감지로 충분. 페이지 DOM 접근 없음)

### manifest.json 권한
```jsonc
{
  "manifest_version": 3,
  "name": "Auto MP4 Downloader",
  "version": "0.1.0",
  "permissions": [
    "webRequest",      // 응답 헤더 관찰 (blocking 아님)
    "downloads",       // 다운로드 트리거
    "storage"          // 설정/상태 영속화
  ],
  "host_permissions": ["<all_urls>"],  // 어느 탭에서든 감지
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup/popup.html" }
}
```
> `webRequest`는 MV3에서 **관찰(observe)은 가능**하다. blocking API가 아니라 감지 전용으로만 쓴다.

---

## 핵심 로직 (background.js)

### 1) 감지: `onHeadersReceived`
- `chrome.webRequest.onHeadersReceived.addListener(fn, { urls: ["<all_urls>"] }, ["responseHeaders"])`
- 판정 로직 (아래 3개 모두 만족해야 트리거):

```
받는다 = enabled === true
        AND (content-type이 "video/mp4"로 시작  OR  URL 경로가 .mp4로 끝남[쿼리스트링 무시])
        AND (content-length 헤더 없음  OR  content-length >= THRESHOLD)
```

- **content-length 필터는 "만" 쓰면 안 됨.** chunked transfer 등으로 `content-length` 헤더가
  아예 없는 응답이 있으므로, **헤더가 없으면 크기 조건은 통과**로 취급하고 content-type/URL로만 판단.
  (크기 필터를 필수 AND로 걸면 정작 받고 싶은 영상이 통과 못 하는 사고 발생)
- `THRESHOLD` 기본값: **5MB (`5 * 1024 * 1024`)** — 일반 본편 영상 대상 기준.
  - 숏폼 등 짧은 클립(수 초짜리)도 대상이면 `2MB`로 낮출 것. 1080p mp4는 대략 초당 0.5~1MB라
    5MB는 5~10초 미만 클립을 걸러낼 수 있음.
  - 크기 필터는 광고 완전 차단용이 아니라 **썸네일/아이콘/프리뷰 제거용 하한선**으로만 기대할 것.
    (5MB 넘는 광고도 존재)

### 2) dedup (필수)
- **URL 정규화 후 Set으로 관리.** Range 재요청·반복 재생으로 같은 영상이 여러 번 감지됨.
- 정규화 규칙:
  - `Range` 관련 쿼리·프래그먼트 제거는 하되, **인증 토큰이 붙은 쿼리스트링은 유지**(제거하면 403 남)
  - 키: `origin + pathname` 기준으로 dedup, 단 서명 URL이면 전체 URL 사용
- `seen: Set<string>` — SW 재시작 대비 `chrome.storage.session`에도 미러링(옵션)
- 이미 본 URL이면 **다운로드 트리거하지 않음**

### 3) 다운로드 트리거
```js
chrome.downloads.download({
  url,                                   // 감지된 mp4 URL 그대로
  filename: `${subfolder}/${safeName}`,  // Downloads/<subfolder>/<name>.mp4
  conflictAction: "uniquify",            // 중복 파일명 자동 넘버링
  saveAs: false                          // 저장 다이얼로그 안 띄움 (무인 저장)
});
```
- **쿠키/인증**: `chrome.downloads.download`는 브라우저 쿠키 jar를 사용하므로 로그인 영상도 헤더 조작 없이 동작. (Referer가 필요한 사이트만 예외 — 그런 경우는 실패 로그로 남기고 사용자에게 알림)
- 파일명 유도: `Content-Disposition` 헤더 우선 → 없으면 URL의 마지막 path 세그먼트 → 그것도 없으면 `video_<timestamp>.mp4`
- `safeName`은 OS 금지문자·경로 구분자 제거

### 4) 결과 추적
- `chrome.downloads.onChanged` 로 `state: complete | interrupted` 수신
- `recent[]` 갱신 후 popup에 반영 (storage 이벤트 or 메시지)

---

## 엣지 케이스 처리 체크리스트
- [ ] **206 Partial Content 폭주** → URL dedup으로 1회만 트리거
- [ ] **같은 영상 재생 반복** → seen Set으로 차단
- [ ] **SW 언로드**(MV3 SW는 수시로 죽음) → 상태는 storage에서 복원, seen은 session storage 미러
- [ ] **content-type이 `application/octet-stream`인 mp4** → URL `.mp4` 폴백으로 커버
- [ ] **소형 프리뷰/광고 mp4** → content-length 임계값(기본 5MB) 필터
- [ ] **content-length 헤더 없음**(chunked 등) → 크기 조건 "통과" 처리, type/URL로만 판단
- [ ] **비활성화 중 감지** → 무시 (리스너는 붙어있되 enabled 게이트)
- [ ] **다운로드 실패(403/interrupted)** → recent에 실패로 기록, 재시도 안 함(중복 방지)

---

## 보안/프라이버시 노트
- `<all_urls>` + `webRequest`는 강한 권한. 헤더만 읽고 **본문·쿠키 값은 로깅하지 않는다.**
- 감지 URL·파일명 외의 정보는 저장하지 않음. 외부 전송 없음(텔레메트리 없음).
- 대상 사이트 ToS 위반 소지 있는 사용은 사용자 책임. 확장 자체는 자체 서비스/허용된 콘텐츠 저장 용도로 설계.

---

## 개발 순서 (권장)
1. manifest + popup 토글 + storage 영속화 (감지 없이 상태만)
2. `onHeadersReceived` 감지 → `console.log`로 URL만 출력 (다운로드 X)
3. dedup 로직 검증 (같은 영상 여러 번 재생해도 1건인지)
4. `chrome.downloads.download` 연결 + 서브폴더 저장
5. 파일명 유도(Content-Disposition) + 실패 처리 + recent 목록
6. content-length 필터·임계값 튜닝

## 테스트 시나리오
- 공개 mp4 직링크 페이지에서 재생 → 1건 저장되는지
- 로그인 필요한 자체 서비스 영상 → 쿠키로 저장되는지
- 탭 A에서 재생 후 탭 B에서 다른 영상 → 둘 다 각각 1건인지
- 비활성화 상태 → 아무것도 안 받는지
- 같은 영상 3회 재생 → 파일 1개(+uniquify 안 터지는지)
