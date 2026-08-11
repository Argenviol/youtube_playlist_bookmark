// ============================================================================
// content.js — YouTube 재생목록 북마크 (북마크)
//
// youtube.com/playlist?list=... 페이지에서 재생목록 안에 북마크(=북마크)을 넣고,
// 우측 하단 패널에서 북마크를 클릭하면 그 영상 위치로 점프한다.
// 북마크는 "위치(인덱스)"가 아니라 "영상 ID(anchorVideoId)"를 앵커로 저장한다.
//   → 영상을 옮기거나 추가해도 북마크가 그 영상을 따라간다.
//
// 핵심 기능:
//   - 북마크 추가/삭제/점프/검색/이름 바꾸기
//   - 북마크를 다른(멀리 있는) 영상으로 재배치 ("📍여기로")
//
// 전부 로컬 저장(chrome.storage.local)만 쓰고, 구글 로그인이나 외부 API 호출은
// 없다.
//
// 저장: chrome.storage.local, 키 `pl:<playlistId>`,
//      값 { sections: [{ id, label, anchorVideoId }] }
// ============================================================================

"use strict";

(() => {
  // ----- 모듈 상태 -------------------------------------------------------------
  let playlistId = null;          // 현재 재생목록 ID
  let data = { sections: [] };    // 현재 재생목록의 북마크 데이터
  let observer = null;            // 항목 컨테이너 감시용
  let observerTarget = null;      // 감시 대상 엘리먼트
  let isRendering = false;        // 렌더 재진입 방지
  let isAutoJumping = false;      // 자동 로딩 점프 중에는 렌더 스킵
  let renderTimer = null;         // 렌더 디바운스 타이머
  let panelEl = null;             // 우측 하단 패널 DOM
  let movingSectionId = null;     // 북마크 이동 모드 — 옮기는 중인 북마크 id
  let toolbarEl = null;           // 공용 hover 도구막대 (항목마다 만들지 않음)
  let hoverItem = null;           // 도구막대가 현재 올라가 있는 항목
  let enabled = true;             // 확장 사용 여부 (팝업 토글, "ytpd:enabled")
  let searchCorpus = null;        // 검색 대상 전체 목록 캐시
  let searchTimer = null;         // 검색 디바운스
  let flashedEls = [];            // 현재 강조 중인 요소들 (점프 표시)
  let flashTimer = null;          // 강조 해제 타이머
  let otherListOpen = false;      // "다른 재생목록" 목록 펼침 상태
  let sectionsOpen = true;        // 북마크 목록 펼침 상태 (길어지면 접을 수 있게)

  const STORAGE_PREFIX = "pl:";
  // 점프 후 강조를 유지하는 시간. 먼 곳으로 갈 때 스크롤·로딩이 오래 걸려서
  // 짧으면 도착 전에 사라진다. 넉넉히 두고, 다음 점프 때 어차피 지워진다.
  const HIGHLIGHT_MS = 20000;

  // ----- 유틸 -----------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function isPlaylistPage() {
    return location.pathname === "/playlist" && new URLSearchParams(location.search).has("list");
  }

  function getPlaylistId() {
    return new URLSearchParams(location.search).get("list");
  }

  // 재생목록 제목을 찾을 후보들 (유튜브 레이아웃이 여러 번 바뀌어 여러 개를 시도).
  // 목록 전체를 훑는 게 아니라 헤더 하나만 집어오므로 비용이 거의 없다.
  const TITLE_SELECTORS = [
    "ytd-playlist-header-renderer yt-formatted-string#text",
    "ytd-playlist-header-renderer h1",
    "yt-page-header-renderer h1",
    "#page-header h1",
    "h1.dynamic-text-view-model-wiz__h1",
  ];

  /**
   * 현재 재생목록 제목.
   * 헤더 DOM 을 먼저 보고, 없으면 document.title 에서 뽑는다.
   * (document.title 은 SPA 이동 직후 아직 안 바뀐 값일 수 있어 후순위)
   */
  function getPlaylistTitle() {
    for (const sel of TITLE_SELECTORS) {
      const el = document.querySelector(sel);
      const t = el && (el.textContent || "").trim();
      if (t) return t;
    }
    let t = (document.title || "").trim();
    t = t.replace(/^\(\d+\)\s*/, "");        // 알림 개수 제거
    t = t.replace(/\s*-\s*YouTube\s*$/i, ""); // 꼬리 제거
    return t.trim();
  }

  /**
   * 현재 재생목록의 제목을 저장소에 캐시해 둔다 (다른 목록에서 이름으로 보이도록).
   * 값이 바뀔 때만 쓰고, 로컬에만 저장한다(동기화 업로드는 건드리지 않음).
   * 여러 번 호출해도 안전하다.
   */
  function backfillTitle() {
    if (!playlistId || !data.sections || !data.sections.length) return;
    const title = getPlaylistTitle();
    if (!title || data.title === title) return;
    data.title = title;
    chrome.storage.local.set({ [storageKey()]: data });
    if (panelEl) renderPanel(); // 이름이 늦게 잡혔으면 화면도 갱신
  }

  /** 화면에 보여줄 재생목록 이름 — 제목이 없으면 캐시된 이름, 그것도 없으면 짧은 ID */
  function displayTitle(title, cached, pid) {
    const t = (title || "").trim() || (cached || "").trim();
    if (t) return t;
    return "재생목록 " + String(pid || "").slice(0, 8) + "…";
  }

  /** 현재 DOM에 로드된 영상 항목들 */
  function getVideoItems() {
    return Array.from(document.querySelectorAll("ytd-playlist-video-renderer"));
  }

  /**
   * 항목에서 영상 ID 추출 (a#video-title → 없으면 a#thumbnail 의 href v 파라미터).
   * 결과를 dataset 에 캐시한다(재생목록 페이지는 항목을 재활용하지 않아 안전).
   * 매 렌더마다 882개 항목에 new URL() 파싱을 반복하던 비용을 없앤다.
   * (못 찾았을 때는 캐시하지 않아, 아직 로딩 중인 항목은 다음에 다시 시도)
   */
  const vidCache = new WeakMap(); // 항목 → videoId (DOM 에 쓰지 않고 메모리에 캐시)
  function getVideoId(item) {
    const cached = vidCache.get(item);
    if (cached) return cached;
    const a = item.querySelector("a#video-title") || item.querySelector("a#thumbnail");
    if (!a || !a.href) return null;
    let vid = null;
    try {
      vid = new URL(a.href, location.origin).searchParams.get("v");
    } catch (_) {}
    if (vid) vidCache.set(item, vid);
    return vid;
  }

  /** 영상 ID로 현재 로드된 항목 찾기 */
  function findItemByVideoId(videoId) {
    return getVideoItems().find((it) => getVideoId(it) === videoId) || null;
  }

  // ----- 저장/로드 ------------------------------------------------------------
  function storageKey() {
    return STORAGE_PREFIX + playlistId;
  }

  function loadSections() {
    return new Promise((resolve) => {
      const key = storageKey();
      chrome.storage.local.get([key], (res) => {
        const stored = res[key];
        data = stored && Array.isArray(stored.sections) ? stored : { sections: [] };
        resolve();
      });
    });
  }

  function saveSections() {
    data.updatedAt = Date.now();
    // 재생목록 제목을 같이 캐시해 둔다 → "북마크가 있는 다른 재생목록" 목록에서
    // API 호출 없이 이름을 보여줄 수 있다. (동기화 문서에는 올리지 않는 로컬 편의 정보)
    const t = getPlaylistTitle();
    if (t) data.title = t;
    return new Promise((resolve) => {
      chrome.storage.local.set({ [storageKey()]: data }, () => resolve());
    });
  }

  // ----- 패널 위치 (오른쪽 위 ↔ 오른쪽 아래, 전역 저장) ------------------------
  const PANEL_POSITIONS = ["tr", "br"];

  function loadPanelPos() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["ytpd:panelPos"], (res) => {
        let pos = res["ytpd:panelPos"];
        if (pos === "top") pos = "tr"; // 옛 값 이관
        else if (pos === "bottom") pos = "br";
        if (!PANEL_POSITIONS.includes(pos)) pos = "tr"; // 옛 6방향 값도 오른쪽 위로
        resolve(pos);
      });
    });
  }
  function savePanelPos(pos) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ "ytpd:panelPos": pos }, () => resolve());
    });
  }
  function applyPanelPos(pos) {
    if (!panelEl) return;
    for (const p of PANEL_POSITIONS) panelEl.classList.remove("ytpd-pos-" + p);
    panelEl.classList.add("ytpd-pos-" + (PANEL_POSITIONS.includes(pos) ? pos : "tr"));
    panelEl.dataset.pos = pos;
  }
  function nextPanelPos(cur) {
    const i = PANEL_POSITIONS.indexOf(cur);
    return PANEL_POSITIONS[(i + 1) % PANEL_POSITIONS.length];
  }

  // ----- 섹션 조작 ------------------------------------------------------------
  function hasSectionForVideo(videoId) {
    return data.sections.some((s) => s.anchorVideoId === videoId);
  }

  function getSection(id) {
    return data.sections.find((s) => s.id === id) || null;
  }

  async function addSection(anchorVideoId, label) {
    if (!anchorVideoId) return;
    if (hasSectionForVideo(anchorVideoId)) {
      toast("이 영상에는 이미 북마크가 있어요");
      return;
    }
    data.sections.push({
      id: uid(),
      label: (label || "북마크").trim() || "북마크",
      anchorVideoId,
    });
    await saveSections();
    scheduleRender();
  }

  /** 북마크 이름 바꾸기 (저장된 값만 고치므로 부담 0) */
  function renameSection(id) {
    const s = getSection(id);
    if (!s) return;
    modalInput(
      "북마크 이름 바꾸기",
      "새 이름 (Enter=확인, Esc=취소)",
      async (val) => {
        const next = (val || "").trim();
        if (!next || next === s.label) return;
        s.label = next;
        await saveSections();
        scheduleRender();
        toast("이름을 바꿨어요");
      },
      s.label
    );
  }

  /**
   * 북마크를 한 칸 위(-1)/아래(+1) 영상으로 옮긴다.
   * 클릭했을 때만 목록을 1회 훑으므로(상시 감시 없음) 렉이 없다.
   */
  async function nudgeSection(id, dir) {
    const s = getSection(id);
    if (!s) return;

    // 기준 영상이 아직 로딩 안 됐으면, 바로 포기하지 말고 그 위치까지 불러온다.
    if (!findItemByVideoId(s.anchorVideoId)) {
      toast("북마크 위치 찾는 중…");
      if (!(await ensureLoaded(s.anchorVideoId))) {
        toast("북마크 기준 영상을 못 찾았어요 (삭제된 영상일 수 있어요)");
        return;
      }
    }

    let items = getVideoItems();
    let cur = items.findIndex((it) => getVideoId(it) === s.anchorVideoId);
    if (cur < 0) return;

    let next = cur + (dir < 0 ? -1 : 1);
    if (next < 0) {
      toast("이미 맨 위예요");
      return;
    }
    // 아래로 옮기는데 다음 영상이 아직 로딩 전이면 조금 더 불러온다
    if (next >= items.length) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(320);
      items = getVideoItems();
      cur = items.findIndex((it) => getVideoId(it) === s.anchorVideoId);
      next = cur + 1;
      if (cur < 0 || next >= items.length) {
        toast("여기가 재생목록 맨 끝이에요");
        return;
      }
    }

    const nvid = getVideoId(items[next]);
    if (!nvid) {
      toast("옮길 영상의 ID를 못 찾았어요");
      return;
    }
    if (data.sections.some((x) => x.id !== s.id && x.anchorVideoId === nvid)) {
      toast("그 영상에는 이미 다른 북마크가 있어요");
      return;
    }

    s.anchorVideoId = nvid;
    await saveSections();
    scheduleRender();
    jumpTo(s); // 옮긴 자리를 눈으로 확인
  }

  async function deleteSection(id) {
    data.sections = data.sections.filter((s) => s.id !== id);
    if (movingSectionId === id) exitMoveMode();
    await saveSections();
    scheduleRender();
  }

  // ----- 북마크 이동 모드 ------------------------------------------------------
  // 노란 라벨 클릭 → 이동 모드 on → 영상의 "📍여기로" 클릭 → 그 영상 아래로 북마크 이동.
  // (API 불필요 — anchorVideoId 만 바꾸는 로컬 작업)
  function enterMoveMode(sectionId) {
    movingSectionId = sectionId;
    document.body.classList.add("ytpd-move-mode");
    const s = getSection(sectionId);
    toast(`"${s ? s.label : "북마크"}" 옮기는 중 — 놓을 영상의 '📍여기로'를 누르세요 (Esc 취소)`);
    scheduleRender();
  }

  function exitMoveMode() {
    if (!movingSectionId) return;
    movingSectionId = null;
    document.body.classList.remove("ytpd-move-mode");
    scheduleRender();
  }

  async function reanchorSection(sectionId, newVideoId) {
    const s = getSection(sectionId);
    if (!s) return;
    if (!newVideoId) {
      toast("이 항목의 영상 ID를 찾지 못했어요");
      return;
    }
    if (newVideoId === s.anchorVideoId) {
      exitMoveMode();
      return; // 같은 자리 — 변화 없음
    }
    const conflict = data.sections.some((x) => x.id !== sectionId && x.anchorVideoId === newVideoId);
    if (conflict) {
      toast("그 영상에는 이미 다른 북마크가 있어요");
      return;
    }
    s.anchorVideoId = newVideoId;
    await saveSections();
    exitMoveMode();
    scheduleRender();
    toast(`"${s.label}" 북마크를 옮겼어요`);
  }

  /**
   * 섹션들을 재생목록 순서대로 정렬한다.
   * 현재 DOM에 로드된 앵커의 인덱스를 기준으로 정렬하고,
   * 로드 안 된 앵커는 뒤로 보낸다(_idx = Infinity).
   */
  function sectionsInOrder() {
    const items = getVideoItems();
    const idxOf = new Map();
    items.forEach((it, i) => {
      const vid = getVideoId(it);
      if (vid && !idxOf.has(vid)) idxOf.set(vid, i);
    });
    return data.sections
      .map((s) => ({ ...s, _idx: idxOf.has(s.anchorVideoId) ? idxOf.get(s.anchorVideoId) : Infinity }))
      .sort((a, b) => a._idx - b._idx);
  }

  /**
   * 각 북마크에 "앞(위)에 있는 영상 수"를 붙인다.
   * 북마크는 앵커 영상 아래에 그려지므로, 북마크 위 영상 수 = 앵커 인덱스 + 1.
   * 영상은 위→아래로 로드되므로 이미 로드된 앵커의 앞쪽은 전부 로드돼 있어
   * 이 값이 안정적이다(뒤쪽은 계속 추가돼 무의미).
   */
  function withCounts(ordered) {
    return ordered.map((s) => ({
      ...s,
      _before: Number.isFinite(s._idx) ? s._idx + 1 : null,
    }));
  }

  // ============================================================================
  // 렌더링
  // ============================================================================
  function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    // 스크롤 중 lazy-load 가 연속으로 일어나므로 살짝 넉넉히 묶어서 렌더 횟수를 줄임
    renderTimer = setTimeout(render, 250);
  }

  // 안전 모드: 유튜브 재생목록 DOM 에는 인라인 북마크를 넣지 않고, 읽지도 않는다.
  // 렌더 = 저장된 북마크 데이터로 패널만 다시 그림 (DOM 스캔 0회).
  // 예전엔 렌더마다 로드된 영상 전체(1000개면 1000번 querySelector)를 훑어 순서를
  // 계산했는데, 목록이 깊어질수록 그 스캔이 렉의 원인이 됐다. 유튜브 목록은
  // "점프할 때만" 1회 조회한다. 패널 순서는 저장된 순서(만든 순서) 그대로.
  function render() {
    if (!enabled || !isPlaylistPage()) return;
    renderPanel(data.sections);
  }

  /**
   * 공용 hover 도구막대 — 항목마다 버튼을 만들지 않고(=노드 폭증 방지),
   * 마우스를 올린 항목으로 "하나뿐인" 도구막대를 옮겨 붙인다.
   * 동작 대상은 항상 현재 올라가 있는 항목(hoverItem).
   */
  function buildToolbar() {
    const tb = document.createElement("div");
    tb.className = "ytpd-item-tools";

    const addDiv = document.createElement("button");
    addDiv.type = "button";
    addDiv.className = "ytpd-tool-btn";
    addDiv.textContent = "＋북마크";
    addDiv.title = "이 영상 아래에 북마크 추가";
    addDiv.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (hoverItem) openInlineInput(hoverItem);
    });

    const hereBtn = document.createElement("button");
    hereBtn.type = "button";
    hereBtn.className = "ytpd-tool-btn ytpd-tool-here";
    hereBtn.textContent = "📍여기로";
    hereBtn.title = "옮기는 중인 북마크를 이 영상 아래로 이동";
    hereBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!movingSectionId || !hoverItem) return;
      reanchorSection(movingSectionId, getVideoId(hoverItem));
    });

    tb.appendChild(addDiv);
    tb.appendChild(hereBtn);
    return tb;
  }

  /**
   * 도구막대 설정 (한 번만). 도구막대는 document.body 에 fixed 로 띄우고,
   * 마우스 올린 항목의 화면 위치에 맞춰 옮긴다. → 유튜브 항목 DOM 에는 절대 안 씀.
   */
  function setupItemToolbar() {
    if (toolbarEl) return;
    toolbarEl = buildToolbar();
    toolbarEl.style.position = "fixed";
    toolbarEl.style.zIndex = "9998";
    toolbarEl.style.display = "none";
    document.body.appendChild(toolbarEl);

    document.addEventListener(
      "pointerover",
      (e) => {
        if (!enabled || !isPlaylistPage()) return;
        if (toolbarEl.contains(e.target)) return; // 도구막대 위에선 유지
        const item = e.target.closest && e.target.closest("ytd-playlist-video-renderer");
        if (!item) {
          if (toolbarEl.style.display !== "none") toolbarEl.style.display = "none";
          hoverItem = null;
          return;
        }
        // 같은 항목 안에서 마우스가 움직일 때는 재측정하지 않는다.
        // (getBoundingClientRect 는 강제 레이아웃을 유발 → 잔렉의 원인. 항목이 바뀔 때만 1회)
        if (item === hoverItem && toolbarEl.style.display !== "none") return;
        hoverItem = item;
        positionToolbar(item);
      },
      true
    );

    // 스크롤 중엔 숨김(고정 좌표가 어긋나므로). 마우스 움직이면 다시 뜸.
    // 이미 숨겨져 있으면 아무것도 안 함 — 매 스크롤 이벤트마다 스타일을 쓰지 않는다.
    window.addEventListener(
      "scroll",
      () => {
        if (toolbarEl.style.display !== "none") toolbarEl.style.display = "none";
      },
      { capture: true, passive: true }
    );
  }

  function positionToolbar(item) {
    const r = item.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 40 || r.top > window.innerHeight) {
      toolbarEl.style.display = "none";
      return;
    }
    const top = r.top + 6;
    toolbarEl.style.display = "flex";
    toolbarEl.style.top = top + "px";
    toolbarEl.style.left = "auto";

    // 기본: 영상 오른쪽 끝에 붙인다 (right = 뷰포트 오른쪽에서의 거리)
    let rightPx = window.innerWidth - r.right + 10;

    // 패널과 세로로 겹치면, 영상 왼쪽 끝까지 멀리 가지 말고
    // "패널 바로 왼쪽"까지만 밀어준다.
    const panel =
      panelEl && panelEl.style.display !== "none" ? panelEl.getBoundingClientRect() : null;
    if (panel && panel.width > 0 && top < panel.bottom && top + 36 > panel.top) {
      const minRight = window.innerWidth - panel.left + 12; // 패널 왼쪽 바로 옆
      if (rightPx < minRight) rightPx = minRight;
    }
    toolbarEl.style.right = rightPx + "px";
  }

  /** 북마크 이름 입력 (body 모달 — 유튜브 항목 DOM 엔 안 씀) */
  function openInlineInput(item) {
    const vid = getVideoId(item);
    if (!vid) {
      toast("이 항목의 영상 ID를 찾지 못했어요");
      return;
    }
    if (hasSectionForVideo(vid)) {
      toast("이 영상에는 이미 북마크가 있어요");
      return;
    }
    modalInput("북마크 이름", "북마크 이름 (Enter=추가, Esc=취소)", (val) => {
      addSection(vid, (val || "북마크").trim() || "북마크");
    });
  }

  // ----- body 모달 (유튜브 DOM 밖) --------------------------------------------
  function modalInput(titleText, placeholder, onOk, initial) {
    const back = document.createElement("div");
    back.className = "ytpd-modal-back";
    const box = document.createElement("div");
    box.className = "ytpd-modal";
    const h = document.createElement("div");
    h.className = "ytpd-modal-title";
    h.textContent = titleText;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ytpd-modal-input";
    input.placeholder = placeholder;
    box.appendChild(h);
    box.appendChild(input);
    back.appendChild(box);
    mountModal(back);
    if (initial) input.value = initial;
    input.focus();
    input.select();
    const close = () => closeModal(back);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const v = input.value;
        close();
        onOk(v);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    back.addEventListener("click", (e) => {
      if (e.target === back) close();
    });
  }

  // ----- 모달 공통 (열려 있는 동안 뒤 페이지 스크롤 잠금) ----------------------
  // 여닫는 곳이 여러 군데라, 반드시 아래 두 함수만 거치게 해서
  // "모달은 닫혔는데 스크롤이 잠긴 채로 남는" 상황을 막는다.

  let lockedScrollY = 0;

  /** 모달을 띄우고 배경 스크롤을 잠근다. Esc 로도 닫힌다. */
  function mountModal(back) {
    document.querySelector(".ytpd-modal-back")?.remove(); // 겹쳐 뜨지 않게
    document.body.appendChild(back);
    if (!document.documentElement.classList.contains("ytpd-modal-open")) {
      lockedScrollY = window.scrollY; // 잠금을 풀 때 되돌리기 위해 기억
      document.documentElement.classList.add("ytpd-modal-open");
    }
    const onKey = (e) => {
      if (e.key === "Escape" && document.body.contains(back)) {
        e.stopPropagation();
        closeModal(back);
      }
    };
    back._ytpdKey = onKey;
    document.addEventListener("keydown", onKey, true);
  }

  /** 모달을 닫고, 남은 모달이 없으면 스크롤 잠금을 푼다 */
  function closeModal(back) {
    if (back) {
      if (back._ytpdKey) document.removeEventListener("keydown", back._ytpdKey, true);
      back.remove();
    }
    if (!document.querySelector(".ytpd-modal-back")) {
      const wasLocked = document.documentElement.classList.contains("ytpd-modal-open");
      document.documentElement.classList.remove("ytpd-modal-open");
      // overflow 를 되돌릴 때 브라우저가 스크롤을 맨 위로 튕기는 경우가 있어 복구
      if (wasLocked && Math.abs(window.scrollY - lockedScrollY) > 2) {
        window.scrollTo(0, lockedScrollY);
      }
    }
  }

  /** 버튼 여러 개 중 하나를 고르는 작은 모달 */
  function modalPick(titleText, choices) {
    const back = document.createElement("div");
    back.className = "ytpd-modal-back";
    const box = document.createElement("div");
    box.className = "ytpd-modal";
    const h = document.createElement("div");
    h.className = "ytpd-modal-title";
    h.textContent = titleText;
    box.appendChild(h);
    for (const c of choices) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ytpd-modal-opt";
      b.innerHTML = "";
      const t = document.createElement("div");
      t.textContent = c.label;
      const d = document.createElement("div");
      d.className = "ytpd-modal-opt-desc";
      d.textContent = c.desc || "";
      b.appendChild(t);
      if (c.desc) b.appendChild(d);
      b.addEventListener("click", () => {
        closeModal(back);
        c.onPick();
      });
      box.appendChild(b);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ytpd-modal-opt";
    cancel.textContent = "취소";
    cancel.addEventListener("click", () => closeModal(back));
    box.appendChild(cancel);
    back.appendChild(box);
    back.addEventListener("click", (e) => {
      if (e.target === back) closeModal(back);
    });
    mountModal(back);
  }

  // ============================================================================
  // 우측 하단 점프 패널
  // ============================================================================
  function ensurePanel() {
    if (panelEl && document.body.contains(panelEl)) return;
    panelEl = document.createElement("div");
    panelEl.id = "ytpd-panel";
    panelEl.innerHTML = `
      <div class="ytpd-panel-head">
        <span class="ytpd-panel-title">북마크</span>
        <span class="ytpd-spacer"></span>
        <button class="ytpd-pos" type="button" title="패널 위치 (오른쪽 위 ↔ 오른쪽 아래)">↕</button>
        <button class="ytpd-toggle" type="button" title="접기/펼치기">▲</button>
      </div>
      <div class="ytpd-panel-body">
        <div class="ytpd-search">
          <input class="ytpd-search-input" type="text" placeholder="노래제목 / 가수 검색">
          <div class="ytpd-search-results"></div>
        </div>
        <div class="ytpd-rows"></div>
      </div>`;
    document.body.appendChild(panelEl);

    panelEl.querySelector(".ytpd-toggle").addEventListener("click", () => {
      panelEl.classList.toggle("ytpd-collapsed");
      panelEl.querySelector(".ytpd-toggle").textContent =
        panelEl.classList.contains("ytpd-collapsed") ? "▼" : "▲";
    });

    // 패널 위치 전환 — 누를 때마다 6방향으로 순환 (선택을 저장해 다음에도 유지)
    panelEl.querySelector(".ytpd-pos").addEventListener("click", async () => {
      const next = nextPanelPos(panelEl.dataset.pos || "tr");
      applyPanelPos(next);
      await savePanelPos(next);
    });
    loadPanelPos().then(applyPanelPos);

    // 검색 (노래제목 / 가수)
    const searchInput = panelEl.querySelector(".ytpd-search-input");
    searchInput.addEventListener("input", () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(searchInput.value), 220);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (searchTimer) clearTimeout(searchTimer);
        runSearch(searchInput.value);
      } else if (e.key === "Escape") {
        searchInput.value = "";
        runSearch("");
      }
    });
  }

  function renderPanel(ordered) {
    ensurePanel();
    const rows = panelEl.querySelector(".ytpd-rows");
    rows.innerHTML = "";

    if (!ordered) ordered = data.sections; // 인자 없이 불릴 때 대비 (DOM 스캔 없음)

    // 현재 재생목록 이름 (클릭하면 북마크가 있는 다른 재생목록 펼치기)
    rows.appendChild(buildPlaylistHeader());

    // 기본 북마크 (항상 표시): 맨 처음 / 맨 끝
    rows.appendChild(buildNavRow("⤒ 맨 처음", "재생목록 맨 처음으로", jumpToStart));
    rows.appendChild(
      buildNavRow("⤓ 맨 끝", "재생목록 맨 끝으로 (끝까지 로딩)", jumpToEnd, "ytpd-row-nav-end")
    );

    if (ordered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ytpd-empty";
      empty.textContent = "북마크가 없어요. 영상에 마우스를 올려 ＋북마크를 눌러보세요.";
      rows.appendChild(empty);
      return;
    }

    // 북마크가 많아지면 목록이 길어지므로 이 부분만 따로 접을 수 있게 한다
    const secHead = document.createElement("div");
    secHead.className = "ytpd-sechead";
    const secName = document.createElement("span");
    secName.className = "ytpd-sechead-name";
    secName.textContent = `북마크 ${ordered.length}개`;
    const secCaret = document.createElement("span");
    secCaret.className = "ytpd-caret-btn";
    secCaret.textContent = sectionsOpen ? "▲" : "▼";
    secHead.appendChild(secName);
    secHead.appendChild(secCaret);
    secHead.title = "북마크 목록 접기/펼치기";
    secHead.addEventListener("click", () => {
      sectionsOpen = !sectionsOpen;
      chrome.storage.local.set({ "ytpd:secOpen": sectionsOpen });
      renderPanel();
    });
    rows.appendChild(secHead);

    if (!sectionsOpen) return;

    for (const s of ordered) {
      const row = document.createElement("div");
      row.className = "ytpd-row" + (s.id === movingSectionId ? " ytpd-row-moving" : "");

      const dot = document.createElement("span");
      dot.className = "ytpd-row-dot";

      const name = document.createElement("span");
      name.className = "ytpd-row-name";
      name.textContent = s.label;

      row.appendChild(dot);
      row.appendChild(name);

      // 행 클릭 = 점프
      row.addEventListener("click", () => jumpTo(s));

      // 버튼을 두 묶음으로 나눈다: [위치 조정] / [편집]
      const navGroup = document.createElement("span");
      navGroup.className = "ytpd-row-group";
      navGroup.appendChild(rowBtn("▲", "한 칸 위 영상으로", () => nudgeSection(s.id, -1)));
      navGroup.appendChild(rowBtn("▼", "한 칸 아래 영상으로", () => nudgeSection(s.id, +1)));
      const moving = s.id === movingSectionId;
      navGroup.appendChild(
        rowBtn(
          moving ? "✕" : "📍",
          moving ? "이동 취소" : "다른 영상으로 옮기기 (누른 뒤 대상 영상의 📍여기로 클릭)",
          () => (moving ? exitMoveMode() : enterMoveMode(s.id)),
          moving ? "ytpd-btn-active" : ""
        )
      );

      const editGroup = document.createElement("span");
      editGroup.className = "ytpd-row-group";
      editGroup.appendChild(rowBtn("✎", "이름 바꾸기", () => renameSection(s.id)));
      editGroup.appendChild(
        rowBtn("🗑", "북마크 삭제", () => deleteSection(s.id), "ytpd-btn-danger")
      );

      row.appendChild(navGroup);
      row.appendChild(editGroup);
      rows.appendChild(row);
    }
  }

  /**
   * 패널 맨 위의 "현재 재생목록" 줄.
   * 북마크는 재생목록마다 따로라, 지금 어느 목록을 보고 있는지 + 북마크를 만들어 둔
   * 다른 목록이 어디인지 알려준다. 목록은 눌렀을 때만 저장소를 읽는다(평소 비용 0).
   */
  function buildPlaylistHeader() {
    const wrap = document.createElement("div");
    wrap.className = "ytpd-plhead";

    const bar = document.createElement("div");
    bar.className = "ytpd-plhead-bar";

    const name = document.createElement("span");
    name.className = "ytpd-plhead-name";
    name.textContent = displayTitle(getPlaylistTitle(), data.title, playlistId);
    name.title = name.textContent;

    const caret = document.createElement("span");
    caret.className = "ytpd-caret-btn";
    caret.textContent = otherListOpen ? "▲" : "▼";

    bar.appendChild(name);
    bar.appendChild(caret);
    bar.title = "클릭: 북마크를 만들어 둔 다른 재생목록 보기";
    bar.addEventListener("click", () => {
      otherListOpen = !otherListOpen;
      renderPanel();
    });

    wrap.appendChild(bar);
    if (otherListOpen) {
      const box = document.createElement("div");
      box.className = "ytpd-plhead-list";
      box.textContent = "불러오는 중…";
      wrap.appendChild(box);
      fillOtherPlaylists(box);
    }
    return wrap;
  }

  /**
   * 북마크가 있는 재생목록 전체를 읽어 목록을 채운다 (펼칠 때 1회).
   * 현재 보고 있는 목록도 "· 현재" 표시와 함께 포함한다 —
   * 그래야 "내 북마크가 어디에 있나"를 한눈에 볼 수 있다.
   */
  function fillOtherPlaylists(box) {
    chrome.storage.local.get(null, (all) => {
      const entries = [];
      for (const key of Object.keys(all)) {
        if (!key.startsWith(STORAGE_PREFIX)) continue;
        const pid = key.slice(STORAGE_PREFIX.length);
        const v = all[key] || {};
        const count = Array.isArray(v.sections) ? v.sections.length : 0;
        if (!count) continue; // 북마크가 없는 목록은 숨김
        const isCurrent = pid === playlistId;
        entries.push({
          pid,
          count,
          isCurrent,
          name: displayTitle(isCurrent ? getPlaylistTitle() : "", v.title, pid),
        });
      }
      // 현재 목록을 맨 위로, 나머지는 이름순
      entries.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      box.textContent = "";
      if (!entries.length) {
        const none = document.createElement("div");
        none.className = "ytpd-plhead-none";
        none.textContent = "아직 북마크를 만든 재생목록이 없어요";
        box.appendChild(none);
        return;
      }

      for (const e of entries) {
        const row = document.createElement("div");
        row.className = "ytpd-plhead-row";

        const a = document.createElement("a");
        a.className = "ytpd-plhead-item" + (e.isCurrent ? " ytpd-plhead-cur" : "");
        a.href = "https://www.youtube.com/playlist?list=" + encodeURIComponent(e.pid);
        a.textContent = `${e.name} (${e.count})` + (e.isCurrent ? "  · 현재" : "");
        a.title = `${e.name} — 북마크 ${e.count}개\n${e.pid}`;
        row.appendChild(a);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "ytpd-plhead-del";
        del.textContent = "✕";
        del.title = "이 재생목록의 북마크를 전부 삭제 (재생목록이 삭제됐거나 더 안 쓸 때)";
        del.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          modalPick(`"${e.name}" 의 북마크 ${e.count}개를 모두 삭제할까요?`, [
            {
              label: "삭제",
              desc: "되돌릴 수 없어요. 재생목록이 삭제됐거나 더 이상 안 쓰는 경우에 쓰세요.",
              onPick: () => deletePlaylistBookmarks(e.pid, box),
            },
          ]);
        });
        row.appendChild(del);

        box.appendChild(row);
      }
    });
  }

  /** 특정 재생목록의 북마크 전체를 지운다 (재생목록이 삭제됐거나 더 안 쓸 때). */
  function deletePlaylistBookmarks(pid, box) {
    chrome.storage.local.remove(STORAGE_PREFIX + pid, () => {
      if (pid === playlistId) {
        data = { sections: [] };
        searchCorpus = null;
        render();
      }
      fillOtherPlaylists(box);
    });
  }

  function rowBtn(label, title, onClick, extraClass) {
    const b = document.createElement("button");
    b.className = "ytpd-row-add" + (extraClass ? " " + extraClass : "");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  // ============================================================================
  // 검색 (노래제목 / 가수)
  // ============================================================================
  /** 비교용 정규화: 소문자 + 공백/기호 제거 (문자·숫자만) */
  function normalizeText(s) {
    return (s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  }

  /** "노래제목 / 가수" → { song, artist }. / 없으면 song 에 전체 */
  function parseQuery(q) {
    const parts = (q || "").split("/");
    if (parts.length >= 2) {
      return { song: normalizeText(parts[0]), artist: normalizeText(parts.slice(1).join("/")) };
    }
    return { song: normalizeText(q), artist: "" };
  }

  /**
   * 검색 대상 전체 목록을 가져온다 (캐시). 화면에 로드된 항목만 대상이라
   * 아직 스크롤로 안 불러온 아래쪽은 못 찾을 수 있다.
   */
  async function getSearchCorpus() {
    if (searchCorpus) return searchCorpus;

    // 화면에 로드된 항목 (불완전 — lazy load)
    searchCorpus = getVideoItems().map((it, idx) => ({
      videoId: getVideoId(it),
      position: idx,
      title: (it.querySelector("#video-title")?.textContent || "").trim(),
      channel: (it.querySelector("ytd-channel-name")?.textContent || "").trim(),
      src: "dom",
    }));
    return searchCorpus;
  }

  function matchEntry(entry, song, artist) {
    const t = normalizeText(entry.title);
    const c = normalizeText(entry.channel);
    if (song && artist) {
      return t.includes(song) && (c.includes(artist) || t.includes(artist));
    }
    const q = song || artist;
    if (!q) return false;
    return t.includes(q) || c.includes(q);
  }

  async function runSearch(rawQuery) {
    const box = panelEl.querySelector(".ytpd-search-results");
    const q = (rawQuery || "").trim();
    if (!q) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = `<div class="ytpd-search-status">검색 중…</div>`;

    const { song, artist } = parseQuery(q);
    let corpus;
    try {
      corpus = await getSearchCorpus();
    } catch (_) {
      box.innerHTML = `<div class="ytpd-search-status">검색 목록을 불러오지 못했어요</div>`;
      return;
    }

    const hits = corpus.filter((e) => e.videoId && matchEntry(e, song, artist));
    box.innerHTML = "";

    // 결과 헤더 (있음/없음 + 소스 안내)
    const status = document.createElement("div");
    status.className = "ytpd-search-status";
    const srcLabel = corpus[0]?.src === "api" ? "전체" : "로드된 부분만";
    if (hits.length) {
      status.innerHTML = `✅ <b>있음</b> · ${hits.length}곳 <span class="ytpd-search-src">(${srcLabel})</span>`;
    } else {
      status.innerHTML = `❌ <b>없음</b> <span class="ytpd-search-src">(${srcLabel})</span>`;
      if (corpus[0]?.src === "dom") {
        status.innerHTML += `<div class="ytpd-search-tip">아래로 스크롤해 더 불러오면 전체에서 찾을 수 있어요</div>`;
      }
    }
    box.appendChild(status);

    // 결과 행 (클릭 = 점프)
    for (const h of hits) {
      const row = document.createElement("div");
      row.className = "ytpd-search-row";
      const name = document.createElement("span");
      name.className = "ytpd-search-name";
      name.textContent = `[${h.position}] ${h.title || h.videoId}`;
      const meta = document.createElement("span");
      meta.className = "ytpd-search-meta";
      meta.textContent = h.channel || "";
      row.appendChild(name);
      row.appendChild(meta);
      row.title = "클릭하면 이 영상으로 이동";
      row.addEventListener("click", () => jumpToVideoId(h.videoId));
      box.appendChild(row);
    }
  }

  // ============================================================================
  // 자동 로딩 점프
  // ============================================================================
  // 섹션 점프는 앵커 영상 ID로 위임
  function jumpTo(section) {
    return jumpToVideoId(section.anchorVideoId);
  }

  /** 기본 북마크: 재생목록 맨 처음으로 */
  function jumpToStart() {
    const items = getVideoItems();
    if (items[0]) {
      items[0].scrollIntoView({ behavior: "smooth", block: "center" });
      flashItem(items[0]);
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  /** 기본 북마크: 재생목록 맨 끝으로 (끝까지 로딩한 뒤 이동) */
  async function jumpToEnd() {
    isAutoJumping = true;
    toast("맨 끝으로 가는 중… (끝까지 로딩)");
    try {
      let lastCount = -1;
      let stagnant = 0;
      for (let tries = 0; tries < 80; tries++) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(280);
        const count = getVideoItems().length;
        if (count === lastCount) {
          if (++stagnant >= 3) break; // 더 안 불려오면 끝 도달
        } else {
          stagnant = 0;
          lastCount = count;
        }
      }
      const items = getVideoItems();
      const last = items[items.length - 1];
      if (last) {
        last.scrollIntoView({ behavior: "smooth", block: "center" });
        flashItem(last);
      }
    } finally {
      isAutoJumping = false;
      scheduleRender();
    }
  }

  /** 패널의 기본 북마크(처음/끝) 행 생성 */
  function buildNavRow(label, title, onClick, extraClass) {
    const row = document.createElement("div");
    row.className = "ytpd-row ytpd-row-nav" + (extraClass ? " " + extraClass : "");
    const dot = document.createElement("span");
    dot.className = "ytpd-row-dot ytpd-dot-nav";
    const name = document.createElement("span");
    name.className = "ytpd-row-name";
    name.textContent = label;
    row.appendChild(dot);
    row.appendChild(name);
    row.title = title;
    row.addEventListener("click", onClick);
    return row;
  }

  /**
   * 특정 영상이 로드될 때까지 페이지 하단으로 스크롤하며 기다린다.
   * 로딩이 잠깐 멈춰도(네트워크 지연) 쉽게 포기하지 않도록 넉넉히 버틴다.
   * @returns 로드된 DOM 항목 또는 null
   */
  async function ensureLoaded(videoId) {
    let item = findItemByVideoId(videoId);
    if (item) return item;

    isAutoJumping = true;
    try {
      let lastCount = -1;
      let stagnant = 0;
      // 최대 시도 200회 + "여러 번 연속으로 더 안 불려올 때"만 끝으로 판단.
      // (예전엔 3번=0.8초만 멈춰도 포기해서, 로딩이 살짝 끊기면 못 찾는다고 떴다)
      for (let tries = 0; tries < 200; tries++) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(260);

        item = findItemByVideoId(videoId);
        if (item) return item;

        const count = getVideoItems().length;
        if (count === lastCount) {
          if (++stagnant >= 8) break; // ~2초간 아무것도 안 불려오면 진짜 끝
        } else {
          stagnant = 0;
          lastCount = count;
        }
      }
      return null;
    } finally {
      isAutoJumping = false;
    }
  }

  async function jumpToVideoId(videoId) {
    let item = findItemByVideoId(videoId);
    if (item) {
      flashItem(item);
      return item;
    }
    toast("영상 찾는 중… (멀리 있으면 시간이 걸려요)");
    item = await ensureLoaded(videoId);
    if (item) {
      flashItem(item);
    } else {
      toast("영상을 못 찾았어요 (재생목록에서 삭제된 영상일 수 있어요)");
    }
    scheduleRender();
    return item;
  }

  /** 앵커 영상으로 스크롤 + 북마크/항목 플래시 */
  /**
   * 점프한 영상을 눈에 띄게 표시한다.
   * 먼 곳으로 점프하면 스크롤·로딩에 시간이 걸려서, 짧게 번쩍이면 도착하기 전에
   * 사라져 버린다. 그래서 사라지지 않는 강조를 걸고 충분히 오래 유지한다.
   * (다음 점프 때 이전 강조는 자동으로 지워진다)
   */
  function flashItem(item) {
    clearFlash();
    // 북마크는 앵커 영상 아래(다음 형제)에 있다.
    const divider = item.nextElementSibling?.classList?.contains("ytpd-divider")
      ? item.nextElementSibling
      : null;
    const target = divider || item;
    target.scrollIntoView({ behavior: "smooth", block: "center" });

    item.classList.add("ytpd-flash");
    flashedEls.push(item);
    if (divider) {
      divider.classList.add("ytpd-flash");
      flashedEls.push(divider);
    }
    flashTimer = setTimeout(clearFlash, HIGHLIGHT_MS);
  }

  /** 강조 해제 (다음 점프 시작 시 / 시간 경과 시) */
  function clearFlash() {
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    for (const el of flashedEls) el.classList.remove("ytpd-flash");
    flashedEls = [];
  }

  // ============================================================================
  // 토스트
  // ============================================================================
  let toastTimer = null;
  function toast(message) {
    let el = document.getElementById("ytpd-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ytpd-toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("ytpd-show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("ytpd-show"), 2600);
  }

  // ============================================================================
  // MutationObserver (항목 lazy load 감시)
  // ============================================================================
  // 로딩이 "멈춘 뒤"에만 한 번 그린다.
  // 새 항목이 계속 들어오는 동안(=유튜브가 목록 로딩 중)에는 타이머가 계속 리셋되어
  // 확장이 DOM 을 전혀 건드리지 않는다 → 로딩과의 충돌/무한로딩·렉 방지.
  let settleTimer = null;
  function scheduleRenderOnSettle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      render();
    }, 500);
  }

  // 안전 모드: 재생목록을 MutationObserver 로 감시하지 않는다.
  // (유튜브 로딩 중 확장이 끼어들지 않아 무한로딩·충돌이 없음)
  function attachObserver() {}
  function detachObserver() {}

  // ============================================================================
  // 초기화 / SPA 대응
  // ============================================================================
  function loadEnabled() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["ytpd:enabled"], (res) => resolve(res["ytpd:enabled"] !== false));
    });
  }

  /** 끄기: 페이지에서 패널·북마크·도구막대를 모두 치우고 감시 중단 */
  function disableUI() {
    detachObserver();
    exitMoveMode();
    document.querySelectorAll(".ytpd-divider").forEach((el) => el.remove());
    if (toolbarEl && toolbarEl.parentNode) toolbarEl.parentNode.removeChild(toolbarEl);
    hoverItem = null;
    if (panelEl) panelEl.style.display = "none";
  }

  async function init() {
    detachObserver();
    // 페이지 이동 중 모달이 열려 있었다면 스크롤 잠금이 남을 수 있으니 정리
    if (!document.querySelector(".ytpd-modal-back")) {
      document.documentElement.classList.remove("ytpd-modal-open");
    }
    clearFlash();
    setupItemToolbar(); // hover 도구막대 위임 (최초 1회만 실제 등록)

    enabled = await loadEnabled();
    if (!enabled) {
      disableUI();
      return;
    }

    if (!isPlaylistPage()) {
      // 재생목록 페이지가 아니면 패널 숨김
      if (panelEl) panelEl.style.display = "none";
      return;
    }
    if (panelEl) panelEl.style.display = "";

    playlistId = getPlaylistId();
    sectionsOpen = await new Promise((r) =>
      chrome.storage.local.get(["ytpd:secOpen"], (res) => r(res["ytpd:secOpen"] !== false))
    );
    searchCorpus = null;
    await loadSections();

    // 컨테이너가 아직 없을 수 있으니 잠깐 기다렸다 옵저버 부착 + 첫 렌더
    let waited = 0;
    while (!document.querySelector("ytd-playlist-video-renderer") && waited < 5000) {
      await sleep(200);
      waited += 200;
      if (!isPlaylistPage()) return; // 그 사이 페이지 이동
    }
    attachObserver();
    render();

    // 재생목록 제목 캐시 보정. 유튜브 헤더가 늦게 그려질 수 있어 한 번 더 확인한다.
    backfillTitle();
    setTimeout(backfillTitle, 1500);
  }

  // 팝업에서 켜기/끄기 → 실시간 반영 (새로고침 불필요)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes["ytpd:enabled"]) return;
    enabled = changes["ytpd:enabled"].newValue !== false;
    if (enabled) init();
    else disableUI();
  });

  // Esc 로 북마크 이동 모드 취소
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && movingSectionId) exitMoveMode();
    },
    true
  );

  // 유튜브는 새로고침 없이 이동 → yt-navigate-finish 로 재초기화
  window.addEventListener("yt-navigate-finish", () => {
    // 약간의 지연 후 (DOM 갱신 대기)
    setTimeout(() => init(), 150);
  });

  // 최초 진입
  init();
})();
