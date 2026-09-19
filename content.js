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
//   - 재생목록에 "이미 있는" 영상을 골라 북마크 바로 밑(섹션 맨 위)으로 이동 ("↦북마크")
//
// 위 대부분은 로컬 저장(chrome.storage.local)만 쓴다. "↦북마크"(영상 이동)만
// 실제 재생목록 순서를 바꾸는 쓰기 작업이라 YouTube Data API v3 가 필요하고,
// 그건 구글 정책상 OAuth 로그인이 필수다. 로그인 버튼은 패널의 작은 ⚙ 에 있고,
// 그 기능을 처음 쓸 때 구글 로그인 창이 자동으로 한 번 뜬다(그 뒤로는 자동 유지).
// 인증·API 호출은 background.js 가 담당하고, 여기서는 chrome.runtime.sendMessage
// 로 요청만 한다.
//
// 저장: chrome.storage.local, 키 `pl:<playlistId>`,
//      값 { sections: [{ id, label, anchorVideoId }] }
// ============================================================================

"use strict";

(() => {
  // ----- 모듈 상태 -------------------------------------------------------------
  let playlistId = null;          // 현재 재생목록 ID
  let data = { sections: [] };    // 현재 재생목록의 북마크 데이터
  let renderTimer = null;         // 렌더 디바운스 타이머
  let signedIn = false;           // OAuth 로그인 상태 (자동 로그인, "↦북마크" 전용)
  let panelEl = null;             // 우측 하단 패널 DOM
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

  // 매 hover 마다 URL 을 새로 파싱하지 않도록 값을 기억한다.
  // 유튜브는 SPA 라 주소는 화면 이동 때만 바뀌고, 그때 init() 이 다시 계산한다.
  let onPlaylistPage = false;
  function computeIsPlaylistPage() {
    onPlaylistPage =
      location.pathname === "/playlist" && location.search.includes("list=");
    return onPlaylistPage;
  }
  function isPlaylistPage() {
    return onPlaylistPage;
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
  let titleCache = ""; // 화면 이동 때 init() 에서 비운다
  function getPlaylistTitle() {
    if (titleCache) return titleCache;
    const t = readPlaylistTitle();
    if (t) titleCache = t;
    return t;
  }

  function readPlaylistTitle() {
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
    const title = readPlaylistTitle(); // 헤더가 늦게 그려질 수 있어 캐시를 거치지 않는다
    if (title) titleCache = title;
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

  /**
   * 현재 DOM에 로드된 영상 항목들.
   * "↦북마크"로 안 보이는 곳으로 보내져 숨겨 둔 항목(.ytpd-hidden)은 제외한다 —
   * 그 영상은 논리적으로 이미 그 자리에 없고, 나중에 그 구간이 로드되면 유튜브가
   * 새 위치에 다시 그린다(아래 reflectMoveInDOM 참고).
   */
  const ITEM_SEL = "ytd-playlist-video-renderer:not(.ytpd-hidden)";

  function getVideoItems() {
    return Array.from(document.querySelectorAll(ITEM_SEL));
  }

  /** 로드된 항목 수 — 배열을 만들지 않는다 (로딩 대기 루프에서 자주 부른다) */
  function countVideoItems() {
    return document.querySelectorAll(ITEM_SEL).length;
  }

  /**
   * 목록을 더 불러오기 위한 스크롤.
   *
   * 페이지 맨 아래(scrollHeight)로 보내면 재생목록 아래에 붙어 있는 "추천 재생목록"
   * 영역으로 내려가 버린다. 유튜브는 목록 끝의 "이어 불러오기" 표시가 화면에 들어올
   * 때만 다음 묶음을 불러오므로, 그 표시(없으면 마지막 줄)를 화면에 넣어야
   * 목록이 계속 이어진다 — 안 그러면 중간에서 멈춘다.
   *
   * @returns 아직 더 불러올 게 남아 있으면 true
   */
  function scrollListDown() {
    const cont = document.querySelector("ytd-continuation-item-renderer");
    if (cont) {
      cont.scrollIntoView({ block: "center" });
      return true;
    }
    const all = document.querySelectorAll(ITEM_SEL);
    const last = all[all.length - 1];
    if (last) {
      last.scrollIntoView({ block: "end" });
      return false; // 이어 불러오기 표시가 없다 = 목록 끝
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    return false;
  }

  /** 이 항목의 한 칸 위(-1)/아래(+1) 영상 항목 (숨긴 줄은 건너뛴다) */
  function siblingItem(item, dir) {
    const step = dir < 0 ? "previousElementSibling" : "nextElementSibling";
    for (let node = item[step]; node; node = node[step]) {
      if (node.matches(ITEM_SEL)) return node;
    }
    return null;
  }

  /** 이 항목 앞에 있는 영상 수 (배열을 만들지 않고 형제만 센다) */
  function countItemsBefore(item) {
    let n = 0;
    for (let node = item.previousElementSibling; node; node = node.previousElementSibling) {
      if (node.matches(ITEM_SEL)) n++;
    }
    return n;
  }

  /** 첫 항목 하나만 필요할 때 (목록 전체를 훑지 않는다) */
  function firstVideoItem() {
    return document.querySelector(ITEM_SEL);
  }

  /**
   * 항목에서 영상 ID 추출 (a#video-title → 없으면 a#thumbnail 의 href v 파라미터).
   *
   * 결과를 캐시하지 않는다. 유튜브는 목록 순서를 바꿀 때(드래그로 옮기기 등) 줄
   * 엘리먼트를 재활용하므로, 엘리먼트에 ID 를 기억해 두면 옮긴 뒤에 엉뚱한 영상을
   * 가리키게 된다 — 실제로 "섞이거나 몇 개가 안 보이는" 증상의 원인이었다.
   * 대신 정규식 한 번으로 끝내 캐시가 없어도 충분히 싸다(new URL 파싱보다 빠르다).
   * 어차피 렌더는 DOM 을 훑지 않고, 목록 조회는 점프·검색 때만 일어난다.
   */
  const V_RE = /[?&]v=([\w-]{6,})/;
  function getVideoId(item) {
    const a = item.querySelector("a#video-title") || item.querySelector("a#thumbnail");
    const href = a && a.getAttribute("href");
    if (!href) return null;
    const m = V_RE.exec(href);
    return m ? m[1] : null;
  }

  /**
   * 영상 ID로 현재 로드된 항목 찾기.
   *
   * 예전엔 로드된 줄을 전부 배열로 만들고 줄마다 링크를 조회해 ID 를 비교했다.
   * 3000줄이면 한 번 찾는 데 수천 번의 DOM 조회가 일어나고, 로딩 대기 루프는 이걸
   * 0.26초마다 반복해서 페이지가 눈에 띄게 멈췄다. 유튜브 항목의 링크는 주소에
   * v=<ID> 를 그대로 담고 있으므로, 선택자 하나로 브라우저가 직접 찾게 한다.
   * (영상 ID 는 [\w-] 로만 이뤄져 선택자에 그대로 넣어도 안전하다)
   */
  const SAFE_VID = /^[\w-]{6,24}$/;
  function findItemByVideoId(videoId) {
    if (!videoId || !SAFE_VID.test(videoId)) return null;
    const hit =
      document.querySelector(`${ITEM_SEL} a#video-title[href*="v=${videoId}"]`) ||
      document.querySelector(`${ITEM_SEL} a#thumbnail[href*="v=${videoId}"]`);
    return hit ? hit.closest("ytd-playlist-video-renderer") : null;
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

  // ----- 패널 위치 (오른쪽 위 → 오른쪽 아래 → 왼쪽 아래 → 왼쪽 위, 전역 저장) ----
  const PANEL_POSITIONS = ["tl", "tr"];

  function loadPanelPos() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["ytpd:panelPos"], (res) => {
        let pos = res["ytpd:panelPos"];
        if (pos === "bl") pos = "tl"; // 아래쪽 위치는 없앴다 — 같은 쪽 위로 이관
        else if (pos === "br" || pos === "bottom" || pos === "top") pos = "tr";
        if (!PANEL_POSITIONS.includes(pos)) pos = "tr"; // 모르는 값은 오른쪽 위로
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
    if (!PANEL_POSITIONS.includes(pos)) pos = "tr";
    for (const p of PANEL_POSITIONS) panelEl.classList.remove("ytpd-pos-" + p);
    panelEl.classList.add("ytpd-pos-" + pos);
    panelEl.dataset.pos = pos;
    for (const btn of panelEl.querySelectorAll(".ytpd-pos")) {
      btn.classList.toggle("ytpd-pos-on", btn.dataset.pos === pos);
    }
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

    // 목록 전체를 배열로 만들지 않고, 기준 영상의 형제만 한 칸 본다.
    let cur = findItemByVideoId(s.anchorVideoId);
    if (!cur) return;

    let target = siblingItem(cur, dir);
    if (!target && dir > 0) {
      // 아래로 옮기는데 다음 영상이 아직 로딩 전이면 조금 더 불러온다
      scrollListDown();
      await sleep(320);
      cur = findItemByVideoId(s.anchorVideoId);
      target = cur && siblingItem(cur, dir);
    }
    if (!target) {
      toast(dir < 0 ? "이미 맨 위예요" : "여기가 재생목록 맨 끝이에요");
      return;
    }

    const nvid = getVideoId(target);
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
    recordNeighbors(s, target);
    scheduleRender();
    jumpTo(s); // 옮긴 자리를 눈으로 확인
  }

  /**
   * 패널에 보이는 북마크 순서를 바꾼다 (끌어서 놓기).
   * 저장된 배열 순서만 바꾸는 로컬 작업이라 유튜브 DOM 과 무관하고 비용이 없다.
   */
  async function reorderSections(dragId, targetId, placeAfter) {
    if (!dragId || dragId === targetId) return;
    const from = data.sections.findIndex((x) => x.id === dragId);
    if (from < 0) return;
    const [moved] = data.sections.splice(from, 1);
    let to = data.sections.findIndex((x) => x.id === targetId);
    if (to < 0) to = data.sections.length - 1;
    data.sections.splice(placeAfter ? to + 1 : to, 0, moved);
    await saveSections();
    renderPanel();
  }

  async function deleteSection(id) {
    data.sections = data.sections.filter((s) => s.id !== id);
    await saveSections();
    scheduleRender();
  }

  /**
   * 북마크 기준 영상 "바로 앞" 영상들을 최대 3개 기억해 둔다.
   * 기준 영상이 재생목록에서 삭제되면 이 중 살아 있는 첫 번째를 새 기준으로 승계한다
   * (150번째가 없어지면 149번째가 그 북마크가 된다).
   * 기준 영상을 실제로 찾은 순간에만 부르므로 추가 로딩이 전혀 없다.
   */
  function recordNeighbors(section, item) {
    if (!section || !item) return;
    // 바로 앞 형제만 몇 칸 거슬러 올라간다 (목록 전체를 훑지 않는다)
    const prev = [];
    let node = item.previousElementSibling;
    while (node && prev.length < 3) {
      if (node.matches(ITEM_SEL)) {
        const v = getVideoId(node);
        if (v && v !== section.anchorVideoId && !prev.includes(v)) prev.push(v);
      }
      node = node.previousElementSibling;
    }
    if (!prev.length) return;
    const cur = section.prevVideoIds || [];
    if (cur.length === prev.length && cur.every((v, n) => v === prev[n])) return; // 그대로면 저장 안 함
    section.prevVideoIds = prev;
    saveSections();
  }

  /**
   * 기준 영상이 사라졌을 때 바로 앞 영상으로 북마크를 승계한다.
   * 이미 목록을 끝까지 훑어본 뒤에만 부르므로 여기서 추가 로딩은 하지 않는다.
   * @returns 승계한 DOM 항목 또는 null
   */
  async function inheritAnchor(section) {
    const prevs = section.prevVideoIds || [];
    for (const [i, v] of prevs.entries()) {
      const it = findItemByVideoId(v);
      if (!it) continue;
      if (hasSectionForVideo(v)) continue; // 그 영상에 이미 다른 북마크가 있으면 건너뛴다
      section.anchorVideoId = v;
      section.prevVideoIds = prevs.slice(i + 1);
      await saveSections();
      recordNeighbors(section, it);
      scheduleRender();
      return it;
    }
    return null;
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
    renderPanel();
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

    const moveBtn = document.createElement("button");
    moveBtn.type = "button";
    moveBtn.className = "ytpd-tool-btn ytpd-tool-move";
    moveBtn.textContent = "↦북마크";
    moveBtn.title = "이 영상을 북마크 바로 밑으로 보내기 (구글 로그인 필요)";
    moveBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!hoverItem) return;
      const vid = getVideoId(hoverItem);
      if (!vid) {
        toast("이 항목의 영상 ID를 찾지 못했어요");
        return;
      }
      openMoveMenu(hoverItem, vid);
    });

    tb.appendChild(addDiv);
    tb.appendChild(moveBtn);
    return tb;
  }

  /**
   * 도구막대 설정 (한 번만). 도구막대는 document.body 에 fixed 로 띄우고,
   * 마우스 올린 항목의 화면 위치에 맞춰 옮긴다. → 유튜브 항목 DOM 에는 절대 안 씀.
   */
  let lastOverTarget = null; // pointerover 조기 종료용
  let toolbarVisible = false; // 스크롤마다 style 문자열을 읽지 않기 위한 플래그

  function hideToolbar() {
    if (!toolbarVisible) return;
    toolbarVisible = false;
    toolbarEl.style.display = "none";
  }

  function setupItemToolbar() {
    if (toolbarEl) return;
    toolbarEl = buildToolbar();
    toolbarEl.style.position = "fixed";
    toolbarEl.style.zIndex = "9998";
    toolbarEl.style.display = "none";
    document.body.appendChild(toolbarEl);
    setupDockResize();

    // 유튜브 자체 기능(≡ 손잡이로 끌어서 순서 바꾸기)이 시작되면, 확장이 숨겨 둔
    // 줄을 즉시 되돌린다. 숨긴 줄이 목록에 남아 있으면 유튜브가 세는 위치와
    // 화면이 어긋나 순서가 섞이거나 몇 개가 사라져 보인다.
    // 숨긴 줄이 하나도 없으면 할 일이 없다 — 배열 길이 확인이 가장 싸므로 맨 앞에 둔다.
    const yieldToYouTube = (e) => {
      if (!anyHidden) return;
      const t = e && e.target;
      if (t && t.closest && t.closest("#ytpd-panel")) return; // 패널 안에서의 드래그는 우리 것
      unhideAll();
      searchCorpus = null; // 줄이 다시 나타났으니 검색 캐시는 무효
    };
    document.addEventListener("dragstart", yieldToYouTube, { capture: true, passive: true });
    // 유튜브 쪽 편집(≡ 끌기, ⋮ 메뉴의 삭제)은 전부 줄 위에서의 pointerdown 으로 시작한다.
    // 특정 버튼 id 를 집어내기보다 "우리 UI 밖의 줄을 눌렀다"는 일반 규칙을 쓴다.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!anyHidden) return;
        const t = e.target;
        if (t && t.closest && t.closest("ytd-playlist-video-renderer")) yieldToYouTube(e);
      },
      { capture: true, passive: true }
    );

    document.addEventListener(
      "pointerover",
      (e) => {
        // pointerover 는 아주 자주 불린다 — 싼 검사부터 순서대로 걸러 낸다.
        if (e.target === lastOverTarget) return; // 같은 엘리먼트 위에서의 움직임
        lastOverTarget = e.target;
        if (!enabled || !onPlaylistPage) return;
        const item = e.target.closest && e.target.closest("ytd-playlist-video-renderer");
        // 같은 항목 안에서 움직일 때는 재측정하지 않는다
        // (getBoundingClientRect 는 강제 레이아웃을 유발 → 잔렉의 원인. 항목이 바뀔 때만 1회)
        if (item && item === hoverItem && toolbarVisible) return;
        if (toolbarEl.contains(e.target)) return; // 도구막대 위에선 유지
        if (!item) {
          hideToolbar();
          hoverItem = null;
          return;
        }
        hoverItem = item;
        positionToolbar(item);
      },
      true
    );

    // 스크롤 중엔 숨김(고정 좌표가 어긋나므로). 마우스 움직이면 다시 뜸.
    // 이미 숨겨져 있으면 아무것도 안 함 — 매 스크롤 이벤트마다 스타일을 쓰지 않는다.
    window.addEventListener("scroll", hideToolbar, { capture: true, passive: true });
  }

  // 유튜브 항목 오른쪽 끝의 ⋮(더보기) 버튼 열 너비. 확장 UI(도구막대·패널)는
  // 이 열을 덮지 않도록 항상 그 왼쪽에 둔다 — 안 그러면 ⋮ 를 누를 수 없다.
  const MENU_COL_PX = 60;

  // 뷰포트 너비·패널 위치는 hover 때마다 재지 않는다. 둘 다 창 크기·패널 조작 때만
  // 바뀌므로 값을 기억해 두고, 그때만 무효로 만든다 (getBoundingClientRect·clientWidth
  // 는 강제 레이아웃을 일으켜 hover 마다 부르면 잔렉이 된다).
  let vwCache = 0;
  let panelRect = null;

  function viewportWidth() {
    if (!vwCache) vwCache = document.documentElement.clientWidth || window.innerWidth;
    return vwCache;
  }

  function getPanelRect() {
    if (!panelRect && panelEl && panelEl.style.display !== "none") {
      panelRect = panelEl.getBoundingClientRect();
    }
    return panelRect;
  }

  /** 창 크기·패널 위치·패널 내용이 바뀌면 기억해 둔 측정값을 버린다 */
  function invalidateMeasurements() {
    vwCache = 0;
    panelRect = null;
  }

  function positionToolbar(item) {
    const r = item.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 40 || r.top > window.innerHeight) {
      hideToolbar();
      return;
    }
    updateDock(r.right, r.left); // 방금 잰 값을 패널 위치에도 재사용 (추가 측정 없음)

    const top = r.top + 6;
    const vw = viewportWidth();
    toolbarEl.style.display = "flex";
    toolbarVisible = true;
    toolbarEl.style.top = top + "px";
    toolbarEl.style.left = "auto";

    // 기본: 영상 오른쪽 끝의 ⋮ 버튼 바로 왼쪽에 붙인다 (right = 뷰포트 오른쪽에서의 거리)
    let rightPx = vw - r.right + MENU_COL_PX;

    // 패널과 세로로 겹치면, 영상 왼쪽 끝까지 멀리 가지 말고
    // "패널 바로 왼쪽"까지만 밀어준다.
    const panel = getPanelRect();
    if (panel && panel.width > 0 && top < panel.bottom && top + 36 > panel.top) {
      const minRight = vw - panel.left + 12; // 패널 왼쪽 바로 옆
      if (rightPx < minRight) rightPx = minRight;
    }
    toolbarEl.style.right = rightPx + "px";
  }

  // ----- 패널 도킹: 유튜브 목록의 ⋮ 열을 덮지 않게 그 왼쪽에 붙인다 --------------
  // 목록 오른쪽 끝 좌표는 (1) hover 시 도구막대가 어차피 재는 항목 rect 에서 공짜로,
  // (2) 페이지 진입 시 1회, (3) 창 크기 변경 시(디바운스) 1회만 얻는다.
  let dockRight = -1;

  let dockLeft = -1;
  let dockWidth = -1;

  const PANEL_W = 372;     // 기본 패널 너비 (content.css 와 같은 값)
  const PANEL_W_MIN = 268; // 왼쪽에 둘 때 이보다는 좁히지 않는다 (읽기 힘들어짐)

  /**
   * 유튜브 본문(재생목록 헤더 카드 + 영상 목록)의 왼쪽 끝 좌표.
   * 왼쪽 위치일 때 패널을 이 선 바깥(왼쪽 여백)에 두기 위한 값이다.
   * 헤더 카드가 목록보다 왼쪽에 있으므로 둘 중 더 왼쪽을 쓴다.
   */
  let headEl = null; // 재생목록 헤더 카드 (화면 이동 때만 다시 찾는다)
  function contentLeftEdge(listLeft) {
    let left = listLeft > 0 ? listLeft : Infinity;
    if (!headEl || !headEl.isConnected) {
      headEl = document.querySelector(
        "ytd-playlist-header-renderer, yt-page-header-renderer, #page-header"
      );
    }
    const head = headEl;
    if (head) {
      const hr = head.getBoundingClientRect();
      if (hr.width > 0 && hr.left < left) left = hr.left;
    }
    return Number.isFinite(left) ? left : 0;
  }

  function updateDock(listRight, listLeft) {
    if (!panelEl || !(listRight > 0)) return;
    const vw = viewportWidth();
    const want = Math.max(18, Math.round(vw - listRight + MENU_COL_PX));
    if (want !== dockRight) {
      dockRight = want; // 값이 같으면 스타일을 건드리지 않는다
      panelEl.style.setProperty("--ytpd-dock-right", want + "px");
    }

    // 왼쪽 값은 패널이 실제로 왼쪽에 있을 때만 잰다 — 기본(오른쪽)에서는 쓰이지도
    // 않는데 hover 마다 문서 전체 querySelector + 레이아웃을 유발하던 비용이었다.
    if (panelEl.dataset.pos !== "tl") return;

    // 왼쪽 위치: 본문 왼쪽의 빈 여백에 넣어 유튜브 화면을 가리지 않게 한다.
    // 여백이 기본 너비보다 좁으면 패널을 그만큼 좁혀서 맞추고(최소 PANEL_W_MIN),
    // 그래도 안 되는 좁은 창에서는 왼쪽 끝에 붙인다.
    const edge = contentLeftEdge(listLeft);
    if (edge > 0) {
      const gap = edge - 24; // 화면 왼쪽 12px + 본문과의 간격 12px
      const w = Math.max(PANEL_W_MIN, Math.min(PANEL_W, Math.round(gap)));
      const wantL = Math.max(12, Math.round(edge - 12 - w));
      if (w !== dockWidth) {
        dockWidth = w;
        panelEl.style.setProperty("--ytpd-panel-w-left", w + "px");
      }
      if (wantL !== dockLeft) {
        dockLeft = wantL;
        panelEl.style.setProperty("--ytpd-dock-left", wantL + "px");
      }
    }
  }

  function measureDock() {
    if (!enabled || !isPlaylistPage()) return;
    const it = firstVideoItem();
    if (!it) return;
    const r = it.getBoundingClientRect();
    updateDock(r.right, r.left);
  }

  let resizeTimer = null;
  function setupDockResize() {
    window.addEventListener("resize", () => {
      invalidateMeasurements();
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(measureDock, 200);
    });
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

  /** "어느 북마크 밑으로 보낼까" 선택 (body 모달) */
  function openMoveMenu(item, vid) {
    if (!data.sections.length) {
      toast("먼저 북마크를 만들어 주세요");
      return;
    }
    const domPos = countItemsBefore(item);
    modalChoose("어느 북마크 밑으로 보낼까요?", data.sections, vid, (s) => {
      moveVideoToSection(vid, s, domPos >= 0 ? domPos : null);
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

  function modalChoose(titleText, orderedSecs, vid, onPick) {
    const back = document.createElement("div");
    back.className = "ytpd-modal-back";
    const box = document.createElement("div");
    box.className = "ytpd-modal";
    const h = document.createElement("div");
    h.className = "ytpd-modal-title";
    h.textContent = titleText;
    box.appendChild(h);
    for (const s of orderedSecs) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "ytpd-modal-opt";
      opt.textContent = "↦ " + s.label;
      if (s.anchorVideoId === vid) opt.disabled = true;
      opt.addEventListener("click", () => {
        closeModal(back);
        onPick(s);
      });
      box.appendChild(opt);
    }
    back.appendChild(box);
    mountModal(back);
    back.addEventListener("click", (e) => {
      if (e.target === back) closeModal(back);
    });
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
        <button class="ytpd-stale" type="button" hidden
          title="↦북마크 로 순서를 바꾼 뒤예요. 이 페이지에 떠 있는 목록은 옛 순서라, 지금 영상을 삭제하거나 끌어서 옮기면 엉뚱한 영상이 지워질 수 있어요.&#10;클릭 = 새로고침">⟳</button>
        <span class="ytpd-spacer"></span>
        <button class="ytpd-nav-top" type="button" title="재생목록 맨 처음으로">⤒</button>
        <button class="ytpd-nav-end" type="button" title="재생목록 맨 끝으로 (끝까지 로딩)">⤓</button>
        <button class="ytpd-pos" type="button" data-pos="tl" title="패널을 왼쪽 위로">◤</button>
        <button class="ytpd-pos" type="button" data-pos="tr" title="패널을 오른쪽 위로">◥</button>
        <button class="ytpd-toggle" type="button" title="접기/펼치기">▲</button>
        <button class="ytpd-set" type="button" title="구글 로그인 설정 (↦북마크 영상 이동용)">⚙</button>
      </div>
      <div class="ytpd-panel-body">
        <div class="ytpd-search">
          <input class="ytpd-search-input" type="text" placeholder="노래제목 / 가수 검색">
          <div class="ytpd-search-results"></div>
        </div>
        <div class="ytpd-rows"></div>
      </div>`;
    document.body.appendChild(panelEl);

    // 화살표로 감싼다 — 그냥 넘기면 click 이벤트가 첫 인자(오류 메시지) 자리로 들어가
    // "로그인 안 됨 — [object PointerEvent]" 처럼 표시된다.
    panelEl.querySelector(".ytpd-set").addEventListener("click", () => openMiniSettings());
    // 경고는 패널을 접어도 보여야 하므로 헤더에 둔다 (본문은 접으면 숨겨진다)
    panelEl.querySelector(".ytpd-stale").addEventListener("click", () => location.reload());

    // 맨 처음/맨 끝은 헤더에 둔다 — 패널을 접어도 계속 쓸 수 있게.
    panelEl.querySelector(".ytpd-nav-top").addEventListener("click", jumpToStart);
    panelEl.querySelector(".ytpd-nav-end").addEventListener("click", jumpToEnd);

    panelEl.querySelector(".ytpd-toggle").addEventListener("click", () => {
      panelEl.classList.toggle("ytpd-collapsed");
      invalidateMeasurements();
      panelEl.querySelector(".ytpd-toggle").textContent =
        panelEl.classList.contains("ytpd-collapsed") ? "▼" : "▲";
    });

    // 패널 위치 전환 — 누를 때마다 6방향으로 순환 (선택을 저장해 다음에도 유지)
    // 위치는 순환이 아니라 버튼 하나에 한 자리씩 (왼쪽 위 / 오른쪽 위)
    for (const btn of panelEl.querySelectorAll(".ytpd-pos")) {
      btn.addEventListener("click", async () => {
        const pos = btn.dataset.pos;
        applyPanelPos(pos);
        invalidateMeasurements();
        measureDock(); // 왼쪽/오른쪽에 따라 필요한 값이 다르므로 한 번 다시 잰다
        await savePanelPos(pos);
      });
    }
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

  function renderPanel() {
    ensurePanel();
    // 경고 배지는 헤더에 있어 패널을 접어도 보인다
    panelEl.querySelector(".ytpd-stale").hidden = !listStale;
    invalidateMeasurements(); // 패널 내용이 바뀌면 기억해 둔 크기는 무효

    const ordered = data.sections;
    const rows = panelEl.querySelector(".ytpd-rows");
    rows.innerHTML = "";

    // 현재 재생목록 이름 (클릭하면 북마크가 있는 다른 재생목록 펼치기)
    rows.appendChild(buildPlaylistHeader());

    // 맨 처음 / 맨 끝은 헤더 버튼(⤒ ⤓)으로 옮겼다 — 접어도 보이도록.

    if (pendingMoved) rows.appendChild(buildMovedRow(pendingMoved));

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
      row.className = "ytpd-row";

      row.draggable = true;
      row.title = "클릭: 그 영상으로 이동 · 끌어서 놓기: 북마크 순서 바꾸기";

      const dot = document.createElement("span");
      dot.className = "ytpd-row-dot";

      const name = document.createElement("span");
      name.className = "ytpd-row-name";
      name.textContent = s.label;

      row.appendChild(dot);
      row.appendChild(name);

      // 행 클릭 = 점프
      row.addEventListener("click", () => {
        if (justDragged) return; // 끌어 놓은 직후의 click 은 무시
        jumpTo(s);
      });

      // 끌어서 북마크 순서 바꾸기 (패널 안에서만 — 유튜브 목록은 건드리지 않는다)
      row.addEventListener("dragstart", (e) => {
        draggingSectionId = s.id;
        row.classList.add("ytpd-row-drag");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          try {
            e.dataTransfer.setData("text/plain", s.id); // 파이어폭스는 값이 있어야 드래그 시작
          } catch (_) {}
        }
      });
      row.addEventListener("dragend", () => {
        draggingSectionId = null;
        row.classList.remove("ytpd-row-drag");
        clearDropMarks();
        justDragged = true;
        setTimeout(() => (justDragged = false), 0);
      });
      row.addEventListener("dragenter", () => {
        // dragover 는 드래그 중 계속 불리므로 크기는 들어올 때 한 번만 잰다
        // (getBoundingClientRect 는 강제 레이아웃)
        const r = row.getBoundingClientRect();
        dragMidY = r.top + r.height / 2;
      });
      row.addEventListener("dragover", (e) => {
        if (!draggingSectionId || draggingSectionId === s.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const after = e.clientY > dragMidY;
        row.classList.toggle("ytpd-drop-after", after);
        row.classList.toggle("ytpd-drop-before", !after);
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("ytpd-drop-before", "ytpd-drop-after");
      });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const after = row.classList.contains("ytpd-drop-after");
        const dragId = draggingSectionId;
        clearDropMarks();
        reorderSections(dragId, s.id, after);
      });

      // 버튼을 두 묶음으로 나눈다: [위치 조정] / [편집]
      const navGroup = document.createElement("span");
      navGroup.className = "ytpd-row-group";
      navGroup.appendChild(rowBtn("▲", "한 칸 위 영상으로", () => nudgeSection(s.id, -1)));
      navGroup.appendChild(rowBtn("▼", "한 칸 아래 영상으로", () => nudgeSection(s.id, +1)));

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

  // 방금 옮긴 영상 — 새로고침(유튜브가 스스로 하는 것 포함) 후에도 그 자리로
  // 돌아갈 수 있게 기억한다. 화면에 이미 있으면 바로 강조하고, 아직 로딩 전이면
  // 패널 맨 위에 줄로 띄워 "누를 때만" 찾아가게 한다(자동 로딩 없음 = 렉 없음).
  const LAST_MOVED_MS = 10 * 60 * 1000;
  let pendingMoved = null;
  // ↦북마크 로 순서를 바꾸면 "지금 화면에 떠 있는" 유튜브 목록은 옛 순서 그대로다.
  // 유튜브는 그 옛 상태를 기준으로 삭제·드래그를 처리하므로, 그 사이에 영상을 지우면
  // 엉뚱한 영상이 지워지거나 다른 영상이 그 자리로 밀려 들어온다 — 새로고침해야
  // 풀린다. 확장이 유튜브의 내부 목록을 고쳐 줄 방법은 없어서, 새로고침 전에는
  // 이 상태를 눈에 띄게 알려 준다. (새로고침하면 바로 사라짐)
  let listStale = false;

  function loadPendingMoved() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["ytpd:lastMoved"], (res) => {
        const v = res["ytpd:lastMoved"];
        pendingMoved =
          v && v.pid === playlistId && Date.now() - (v.ts || 0) < LAST_MOVED_MS ? v.videoId : null;
        resolve();
      });
    });
  }

  /**
   * "방금 옮긴 영상으로" 안내만 지운다.
   * listStale(= 유튜브 목록이 옛 순서라는 안전 경고)은 여기서 끄지 않는다 —
   * 줄을 숨겼다고 삭제가 안전해지는 건 아니고, 그건 새로고침으로만 풀린다.
   */
  function clearPendingMoved() {
    pendingMoved = null;
    chrome.storage.local.remove("ytpd:lastMoved");
    scheduleRender();
  }

  /** "방금 옮긴 영상으로" 줄 — 누르면 그 영상까지 찾아간다 */
  function buildMovedRow(videoId) {
    const row = document.createElement("div");
    row.className = "ytpd-row ytpd-row-moved";
    const dot = document.createElement("span");
    dot.className = "ytpd-row-dot";
    const name = document.createElement("span");
    name.className = "ytpd-row-name";
    name.textContent = "↩ 방금 옮긴 영상으로";
    row.appendChild(dot);
    row.appendChild(name);
    row.title = "↦북마크 로 보낸 영상으로 이동합니다";
    row.addEventListener("click", () => {
      jumpToVideoId(videoId).then((item) => {
        if (item) clearPendingMoved();
      });
    });
    row.appendChild(rowBtn("✕", "이 줄 숨기기", () => clearPendingMoved()));
    return row;
  }

  let draggingSectionId = null; // 패널에서 끌고 있는 북마크 id
  let dragMidY = 0;             // 지금 지나가는 줄의 세로 중앙 (dragenter 때 1회 측정)
  let justDragged = false;      // 드래그 직후의 click(=점프) 무시용

  function clearDropMarks() {
    if (!panelEl) return;
    panelEl
      .querySelectorAll(".ytpd-drop-before, .ytpd-drop-after")
      .forEach((el) => el.classList.remove("ytpd-drop-before", "ytpd-drop-after"));
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
  async function jumpTo(section) {
    // 찾기·로딩·강조는 jumpToVideoId 가 전부 한다. 여기서 더하는 건 두 가지뿐:
    // 성공하면 이웃 기억, 실패하면 바로 앞 영상으로 승계.
    const item = await jumpToVideoId(section.anchorVideoId, { quiet: true });
    if (item) {
      recordNeighbors(section, item);
      return item;
    }
    // 기준 영상이 재생목록에서 삭제된 경우 (이미 끝까지 훑은 뒤라 추가 로딩 없음)
    const heir = await inheritAnchor(section);
    if (heir) {
      flashItem(heir);
      toast(`"${section.label}" 기준 영상이 없어져서 바로 앞 영상으로 옮겼어요`);
      return heir;
    }
    toast("영상을 못 찾았어요 (재생목록에서 삭제된 영상일 수 있어요)");
    return null;
  }

  /** 기본 북마크: 재생목록 맨 처음으로 */
  function jumpToStart() {
    const first = firstVideoItem();
    if (first) {
      first.scrollIntoView({ behavior: "smooth", block: "center" });
      flashItem(first);
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  /** 기본 북마크: 재생목록 맨 끝으로 (끝까지 로딩한 뒤 이동) */
  async function jumpToEnd() {
    toast("맨 끝으로 가는 중… (끝까지 로딩)");
    try {
      let lastCount = -1;
      let stagnant = 0;
      // 긴 재생목록도 끝까지 가도록 시도 횟수를 넉넉히 둔다. 어차피 끝에 닿으면
      // "이어 불러오기" 표시가 사라져서 곧장 빠져나온다.
      for (let tries = 0; tries < 400; tries++) {
        const more = scrollListDown();
        await sleep(280);
        const count = countVideoItems();
        if (!more && count === lastCount) break; // 표시도 없고 더 안 늘면 진짜 끝
        if (count === lastCount) {
          if (++stagnant >= 6) break; // 한참 아무것도 안 불려오면 중단
        } else {
          stagnant = 0;
          lastCount = count;
        }
      }
      const all = document.querySelectorAll(ITEM_SEL);
      const last = all[all.length - 1];
      if (last) {
        last.scrollIntoView({ behavior: "smooth", block: "center" });
        flashItem(last);
      }
    } finally {
      scheduleRender();
    }
  }

  /**
   * 특정 영상이 로드될 때까지 목록 끝으로 스크롤하며 기다린다.
   * 로딩이 잠깐 멈춰도(네트워크 지연) 쉽게 포기하지 않도록 넉넉히 버틴다.
   * @param {string} videoId
   * @param {number} maxTries  최대 스크롤 시도 횟수 (기본 200 = 끝까지).
   *   사용자가 직접 지목한 "점프"·▲▼ 에서만 쓴다. "↦북마크" 반영에는 쓰지 않는다 —
   *   유튜브는 한 번 로드한 항목을 다시 비우지 않아서, 이동할 때마다 로딩하면
   *   그 뒤로 재생목록을 볼 때마다 계속 무거워진다(reflectMoveInDOM 참고).
   * @returns 로드된 DOM 항목 또는 null
   */
  async function ensureLoaded(videoId, maxTries = 200) {
    let item = findItemByVideoId(videoId);
    if (item) return item;

    let lastCount = -1;
    let stagnant = 0;
    // "여러 번 연속으로 더 안 불려올 때"만 끝으로 판단.
    // (예전엔 3번=0.8초만 멈춰도 포기해서, 로딩이 살짝 끊기면 못 찾는다고 떴다)
    for (let tries = 0; tries < maxTries; tries++) {
      const more = scrollListDown();
      await sleep(260);

      item = findItemByVideoId(videoId);
      if (item) return item;

      const count = countVideoItems();
      if (!more && count === lastCount) break; // 목록 끝까지 왔는데 없다
      if (count === lastCount) {
        if (++stagnant >= 8) break; // ~2초간 아무것도 안 불려오면 진짜 끝
      } else {
        stagnant = 0;
        lastCount = count;
      }
    }
    return null;
  }

  /**
   * 영상으로 이동 + 강조. 로드 전이면 찾을 때까지 스크롤한다.
   * @param {{quiet?: boolean}} opts quiet=true 면 실패 토스트를 띄우지 않는다
   *   (부르는 쪽에 승계 같은 다음 수가 있을 때 — jumpTo 참고)
   */
  async function jumpToVideoId(videoId, opts) {
    let item = findItemByVideoId(videoId);
    if (item) {
      flashItem(item);
      return item;
    }
    toast("영상 찾는 중… (멀리 있으면 시간이 걸려요)");
    item = await ensureLoaded(videoId);
    if (item) {
      flashItem(item);
    } else if (!(opts && opts.quiet)) {
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
  function flashItem(item, smooth = true) {
    clearFlash();
    // 북마크는 앵커 영상 아래(다음 형제)에 있다.
    const divider = item.nextElementSibling?.classList?.contains("ytpd-divider")
      ? item.nextElementSibling
      : null;
    const target = divider || item;
    // smooth 스크롤은 애니메이션 내내 매 프레임 긴 목록을 다시 그려야 해서,
    // 방금 DOM 을 건드린 직후(영상 이동)에 쓰면 눈에 띄게 멈칫거린다.
    // 그런 경우는 즉시 이동(instant)으로 그 비용을 없앤다.
    target.scrollIntoView({ behavior: smooth ? "smooth" : "instant", block: "center" });

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
  // 인증 (자동 로그인) / 영상 이동
  // ============================================================================
  function bg(action, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(Object.assign({ action }, payload), (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp) {
          reject(new Error("백그라운드 응답이 없어요"));
          return;
        }
        if (!resp.ok) {
          reject(new Error(resp.error || "오류가 발생했어요"));
          return;
        }
        resolve(resp.result);
      });
    });
  }

  /** 현재 로그인 상태를 조용히 확인 (UI 표시 없음) */
  async function refreshAuthState() {
    try {
      const res = await bg("getAuthStatus");
      signedIn = !!res.signedIn;
    } catch (_) {
      signedIn = false;
    }
  }

  /**
   * 쓰기 동작(영상 이동) 직전에 호출. 로그인 안 돼 있으면 구글 로그인 창을
   * 한 번 띄운다(자동 로그인). 성공하면 true.
   */
  async function ensureSignedIn() {
    if (signedIn) return true;
    try {
      await bg("signIn"); // 최초 1회 구글 로그인 팝업
      signedIn = true;
      return true;
    } catch (err) {
      // 실패 원인이 무엇이든 설정·사용법이 있는 ⚙ 모달을 바로 연다
      // (여기서만 클라이언트 ID 입력과 단계별 안내를 볼 수 있다)
      toast("구글 로그인이 필요해요: " + err.message);
      openMiniSettings(err.message);
      return false;
    }
  }

  /**
   * 최소 설정 모달 — 로그인/로그아웃 + 본인 구글 API 클라이언트 ID.
   * "↦북마크"(영상 이동)에만 필요하고, 다른 기능엔 필요 없다.
   */
  async function openMiniSettings(errorMessage) {
    const back = document.createElement("div");
    back.className = "ytpd-modal-back";
    const box = document.createElement("div");
    box.className = "ytpd-modal ytpd-modal-wide";
    box.innerHTML = `
      <div class="ytpd-modal-title">⚙ 구글 로그인 설정</div>
      <div class="ytpd-set-desc">
        "↦북마크"(영상을 북마크 밑으로 이동)에만 필요합니다. 북마크 추가·점프·검색 등
        다른 기능은 로그인 없이 그대로 됩니다.
      </div>

      <details class="ytpd-guide">
        <summary>📖 사용법 — 구글 로그인 준비 (처음 한 번만, 약 5분)</summary>
        <div class="ytpd-guide-body">
          <div class="ytpd-guide-why">
            유튜브 재생목록의 <b>순서를 바꾸는 것</b>은 구글이 로그인한 본인만 허용합니다.
            그래서 "내 구글 계정으로 이 확장을 쓰겠다"는 열쇠(OAuth 클라이언트 ID)를
            한 번 만들어야 합니다. 무료이고, 아래 순서대로 누르기만 하면 됩니다.
          </div>
          <ol class="ytpd-guide-steps">
            <li>
              <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">
                구글 클라우드 프로젝트 만들기 ↗</a>
              <div>이름은 아무거나 (예: <code>youtube-bookmark</code>) → <b>만들기</b>.
                이미 프로젝트가 있으면 건너뛰어도 됩니다.</div>
            </li>
            <li>
              <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">
                YouTube Data API v3 켜기 ↗</a>
              <div>파란 <b>사용</b>(Enable) 버튼을 누릅니다. 위쪽에 1번에서 만든 프로젝트가
                선택돼 있는지 확인하세요.</div>
            </li>
            <li>
              <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">
                OAuth 동의 화면 만들기 ↗</a>
              <div>앱 이름·이메일만 채우고, 사용자 유형은 <b>외부</b>(External)로 저장합니다.</div>
            </li>
            <li>
              <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">
                내 구글 계정을 테스트 사용자로 추가 ↗</a>
              <div><b>테스트 사용자 → 추가</b> 에 본인 지메일 주소를 넣습니다.
                <b>이걸 빠뜨리면 로그인할 때 거부됩니다.</b></div>
            </li>
            <li>
              <a href="https://console.cloud.google.com/apis/credentials/oauthclient" target="_blank" rel="noopener">
                OAuth 클라이언트 ID 만들기 ↗</a>
              <div>유형은 반드시 <b>웹 애플리케이션</b>. 그리고
                <b>승인된 리디렉션 URI</b> 에 아래 "리디렉션 URI" 칸의 값을
                (<b>복사</b> 버튼) 그대로 붙여넣고 만들기를 누릅니다.</div>
            </li>
            <li>
              만들어지면 뜨는 <b>클라이언트 ID</b>
              (<code>...apps.googleusercontent.com</code>)를 복사해
              아래 칸에 붙여넣고 <b>저장</b> → <b>구글 로그인</b> 을 누르면 끝입니다.
              <div>나중에 다시 볼 때는
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">사용자 인증 정보 ↗</a>
                에서 확인합니다.</div>
            </li>
          </ol>
          <div class="ytpd-guide-note">
            로그인할 때 "확인되지 않은 앱" 경고가 나오면 <b>고급 → 이동</b> 을 누르세요.
            구글 심사를 받지 않은 본인 전용 앱이라 뜨는 정상 경고입니다.
            하루 사용량은 영상 이동 약 200회까지입니다.
          </div>
        </div>
      </details>
      <div class="ytpd-set-status" data-auth>확인 중…</div>
      <div class="ytpd-set-row">
        <button type="button" class="ytpd-set-btn" data-login>구글 로그인</button>
        <button type="button" class="ytpd-set-btn" data-logout>로그아웃</button>
      </div>
      <div class="ytpd-set-label">리디렉션 URI</div>
      <div class="ytpd-set-row">
        <input class="ytpd-modal-input" data-redirect readonly>
        <button type="button" class="ytpd-set-btn" data-copy>복사</button>
      </div>
      <div class="ytpd-set-label">OAuth 클라이언트 ID</div>
      <input class="ytpd-modal-input" data-clientid placeholder="000000-xxxx.apps.googleusercontent.com">
      <div class="ytpd-set-label">
        OAuth 클라이언트 보안 비밀번호(secret) — 선택. 넣으면 PC를 껐다 켜도
        로그인이 계속 유지됩니다(refresh token). 비워두면 지금처럼 1시간마다
        조용히 갱신을 시도하고, 가끔 로그인 창이 다시 뜰 수 있어요.
      </div>
      <input class="ytpd-modal-input" data-clientsecret type="password" placeholder="선택 — 비워두면 기존 방식 그대로">
      <div class="ytpd-set-row">
        <button type="button" class="ytpd-set-btn" data-savekey>저장</button>
      </div>
      <div class="ytpd-set-row ytpd-set-foot">
        <button type="button" class="ytpd-set-btn" data-close>닫기</button>
      </div>`;
    back.appendChild(box);
    mountModal(back);

    const $ = (sel) => box.querySelector(sel);
    const authEl = $("[data-auth]");

    const paintAuth = () => {
      authEl.textContent = signedIn
        ? "✓ 로그인됨"
        : errorMessage
        ? "로그인 안 됨 — " + errorMessage
        : "로그인 안 됨";
      authEl.classList.toggle("ytpd-set-ok", signedIn);
    };

    await refreshAuthState();
    paintAuth();
    chrome.storage.local.get(["ytpd:clientId", "ytpd:clientSecret"], (res) => {
      $("[data-clientid]").value = res["ytpd:clientId"] || "";
      $("[data-clientsecret]").value = res["ytpd:clientSecret"] || "";
    });
    bg("getRedirectUri")
      .then((r) => ($("[data-redirect]").value = r.uri))
      .catch(() => ($("[data-redirect]").value = "(확인 실패)"));

    $("[data-login]").addEventListener("click", async () => {
      try {
        await bg("signIn");
        signedIn = true;
        errorMessage = "";
        paintAuth();
        toast("로그인했어요");
      } catch (e) {
        errorMessage = e.message;
        paintAuth();
        toast(e.message);
      }
    });

    $("[data-logout]").addEventListener("click", async () => {
      try {
        await bg("signOut");
        signedIn = false;
        paintAuth();
        toast("로그아웃했어요");
      } catch (e) {
        toast(e.message);
      }
    });

    $("[data-copy]").addEventListener("click", () => {
      const v = $("[data-redirect]").value;
      navigator.clipboard.writeText(v).then(
        () => toast("복사했어요"),
        () => toast("복사 실패 — 직접 선택해 복사해 주세요")
      );
    });

    $("[data-savekey]").addEventListener("click", async () => {
      const id = $("[data-clientid]").value.trim();
      const secret = $("[data-clientsecret]").value.trim();
      const prev = await new Promise((r) =>
        chrome.storage.local.get(["ytpd:clientId", "ytpd:clientSecret"], r)
      );
      const changed = prev["ytpd:clientId"] !== id || prev["ytpd:clientSecret"] !== secret;
      chrome.storage.local.set({ "ytpd:clientId": id, "ytpd:clientSecret": secret }, async () => {
        if (changed) {
          // 설정이 바뀌면 예전 방식으로 캐시된 토큰이 새 방식과 안 맞을 수 있어 정리한다.
          try {
            await bg("signOut");
          } catch (_) {}
          signedIn = false;
          paintAuth();
        }
        toast(id ? "저장했어요. 다시 로그인해 주세요" : "지웠어요");
      });
    });

    $("[data-close]").addEventListener("click", () => closeModal(back));
    back.addEventListener("click", (e) => {
      if (e.target === back) closeModal(back);
    });
  }

  // 쓰기 작업 직렬 처리 큐 — 첫 작업이 끝나기 전에 다음을 눌러도, 클릭 순서대로
  // 하나씩 처리되어 경쟁(레이스)으로 순서가 꼬이는 걸 막는다.
  let opChain = Promise.resolve();
  function runSerial(task) {
    const next = opChain.then(task, task);
    opChain = next.catch(() => {});
    return next;
  }

  // 섹션별 "마지막으로 보낸 영상" — 다음 영상을 그 바로 뒤에 놓아 보낸 순서를 유지한다.
  // (페이지 새로고침/이동 시 init 에서 초기화)
  let lastPlacedBySection = {};

  /**
   * 영상을 놓을 "기준 영상"의 현재 position 을 구한다.
   * 기준 = 이 섹션에 직전에 보낸 영상(있으면) → 없으면 북마크 기준(앵커) 영상.
   * 항상 API 로 최신값을 받아 연속 작업에도 정확하다.
   * @returns {Promise<number|null>}
   */
  async function getReferencePos(section) {
    const lastVid = lastPlacedBySection[section.id];
    if (lastVid && lastVid !== section.anchorVideoId) {
      const list = (await bg("findItems", { playlistId, videoId: lastVid })).items;
      if (list.length) return list[list.length - 1].position; // 가장 아래(최근) 것
    }
    const anchorList = (await bg("findItems", { playlistId, videoId: section.anchorVideoId })).items;
    return anchorList.length ? anchorList[0].position : null;
  }

  // "↦북마크"로 아직 로드 안 된 곳으로 보낸 영상의 원래 줄은 클래스로만 표시한다.
  // (엘리먼트를 배열에 담아 두면, 유튜브가 그 줄을 재활용했을 때 엉뚱한 영상이
  //  숨겨진 채로 남는다 — 영상 ID 캐시를 없앤 것과 같은 이유다.)
  // anyHidden 은 "지금 숨긴 게 있나"를 O(1) 로 답하기 위한 플래그일 뿐이다.
  let anyHidden = false;

  function hideMovedItem(node) {
    node.classList.add("ytpd-hidden");
    anyHidden = true;
    if (hoverItem === node) {
      hoverItem = null;
      if (toolbarEl) hideToolbar();
    }
  }

  function unhideAll() {
    if (!anyHidden) return;
    anyHidden = false;
    document
      .querySelectorAll("ytd-playlist-video-renderer.ytpd-hidden")
      .forEach((el) => el.classList.remove("ytpd-hidden"));
  }

  /**
   * 옮긴 영상을 화면(유튜브 목록)에도 반영한다.
   *
   * 하는 일은 딱 하나 — 옮긴 영상의 **원래 노드를 숨긴다**. 서버 순서는 이미
   * 바뀌었으므로, 새 자리는 그 구간이 (다시) 로드될 때 유튜브가 직접 그린다.
   *
   * 예전에는 기준 영상이 화면에 있으면 노드를 그 뒤로 옮겨 붙여 "바로 쌓이는" 모습을
   * 보여 줬는데, 유튜브 목록의 자식 순서를 바꾸는 것은 유튜브 자신의 목록 컴포넌트가
   * 관리하는 구조를 건드리는 일이라 이어 불러오기가 엉켜 무한 로딩이 났다.
   * 그래서 지금은 구조를 전혀 바꾸지 않고, 클래스 하나로 숨기기만 한다.
   *
   * 여기서 아래쪽을 더 로딩하지도 않는다 — 유튜브가 그 사이 수백 개를 더 렌더링하고
   * 그걸 다시 비우지 않아 그 뒤로 계속 느려지기 때문이다(성능 설계 원칙).
   *
   * 사용자가 버튼을 누른 이 순간에만 동작하고, 상시 감시는 하지 않는다.
   */
  function reflectMoveInDOM(movingVid, refVid) {
    const movingNode = findItemByVideoId(movingVid);
    if (!movingNode) return;
    hideMovedItem(movingNode);
    const refNode = findItemByVideoId(refVid); // 숨긴 줄은 ITEM_SEL 에서 제외된다
    if (refNode && refNode !== movingNode) {
      // 어디로 갔는지 보이게 기준 영상만 강조한다 (목록 구조는 건드리지 않음).
      // 방금 DOM 을 건드린 직후라 smooth 스크롤은 무거워서 즉시 이동.
      flashItem(refNode, false);
    }
  }

  // 외부에서 부르는 진입점: 직렬 큐에 넣어 순서를 보장한다.
  function moveVideoToSection(videoId, section, domPos) {
    return runSerial(() => doMoveVideoToSection(videoId, section, domPos));
  }

  async function doMoveVideoToSection(videoId, section, domPos) {
    // 최신 섹션 참조 (메뉴를 띄운 뒤 데이터가 바뀌었을 수 있어 id로 다시 찾는다)
    section = getSection(section.id) || section;

    if (videoId === section.anchorVideoId) {
      toast("이 영상은 이 북마크의 기준 영상이에요");
      return;
    }
    if (!(await ensureSignedIn())) return;

    toast("영상을 옮기는 중…");
    try {
      // 옮길 영상의 playlistItemId·position — videoId 필터로 그 영상만 조회(빠름).
      const movingList = (await bg("findItems", { playlistId, videoId })).items;
      if (!movingList.length) {
        toast("옮길 영상을 목록에서 찾지 못했어요");
        return;
      }
      // 같은 영상이 여러 번 들어있으면 클릭한 DOM 위치에 가장 가까운 것을 고른다.
      let moving = movingList[0];
      if (movingList.length > 1 && domPos != null) {
        moving = movingList.reduce(
          (best, it) =>
            Math.abs((it.position ?? 0) - domPos) < Math.abs((best.position ?? 0) - domPos) ? it : best,
          movingList[0]
        );
      }

      // 기준(앵커 또는 직전에 보낸 영상)의 현재 position — 그 "바로 뒤"에 놓는다.
      const r = await getReferencePos(section);
      if (r == null) {
        toast("북마크의 기준 영상을 목록에서 찾지 못했어요");
        return;
      }

      const a = moving.position; // 옮길 영상의 현재 위치
      // 기준 바로 뒤에 놓는다. 항목을 빼면 그 아래가 한 칸 당겨지므로,
      // 위에서 내려올 때(a<r)는 r, 아래에서 올라올 때(a>r)는 r+1 이 목표.
      const target = a < r ? r : r + 1;

      // 화면에서 이 영상을 붙일 기준(직전에 보낸 영상 → 없으면 앵커).
      // lastPlaced 를 갱신하기 "전" 값을 써야 방금 옮긴 것 바로 뒤에 쌓인다.
      const domRefVid =
        lastPlacedBySection[section.id] && lastPlacedBySection[section.id] !== section.anchorVideoId
          ? lastPlacedBySection[section.id]
          : section.anchorVideoId;

      await bg("moveItem", {
        playlistItemId: moving.playlistItemId,
        playlistId,
        videoId,
        position: target,
      });

      lastPlacedBySection[section.id] = videoId; // 다음 영상은 이 뒤에 → 보낸 순서 유지
      searchCorpus = null;
      // 유튜브가 스스로 새로고침해도 방금 옮긴 영상으로 돌아올 수 있게 기억해 둔다
      pendingMoved = videoId;
      listStale = true; // 새로고침 전까지 유튜브 목록은 옛 순서 (삭제·드래그 위험)
      chrome.storage.local.set({
        "ytpd:lastMoved": { pid: playlistId, videoId, ts: Date.now() },
      });
      // 새로고침 없이 화면에도 바로 반영 (기준이 로드돼 있으면 DOM 에서 자리 이동,
      // 아니면 원래 자리에서만 치우고, 새 자리는 그 구간이 로드될 때 유튜브가 그린다).
      reflectMoveInDOM(videoId, domRefVid);
      toast(
        `"${section.label}" 밑으로 옮겼어요 — 영상을 삭제하거나 드래그하기 전에 새로고침하세요`
      );
      scheduleRender();
    } catch (err) {
      toast(err.message);
    }
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
  // 초기화 / SPA 대응
  // ============================================================================
  function loadEnabled() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["ytpd:enabled"], (res) => resolve(res["ytpd:enabled"] !== false));
    });
  }

  /** 끄기: 페이지에서 패널·북마크·도구막대를 모두 치우고 감시 중단 */
  function disableUI() {
    document.querySelectorAll(".ytpd-divider").forEach((el) => el.remove());
    unhideAll();
    if (toolbarEl && toolbarEl.parentNode) toolbarEl.parentNode.removeChild(toolbarEl);
    hoverItem = null;
    if (panelEl) panelEl.style.display = "none";
  }

  async function init() {
    // 페이지 이동 중 모달이 열려 있었다면 스크롤 잠금이 남을 수 있으니 정리
    if (!document.querySelector(".ytpd-modal-back")) {
      document.documentElement.classList.remove("ytpd-modal-open");
    }
    clearFlash();
    unhideAll(); // 이전 페이지에서 숨겨 둔 항목은 이 페이지에선 무효
    listStale = false; // 새로 그려진 목록이므로 유튜브 쪽 순서도 최신이다
    computeIsPlaylistPage(); // hover 경로가 읽는 캐시
    titleCache = "";
    headEl = null;
    invalidateMeasurements();
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
    lastPlacedBySection = {};
    await loadSections();
    await refreshAuthState();

    // 컨테이너가 아직 없을 수 있으니 잠깐 기다렸다 옵저버 부착 + 첫 렌더
    let waited = 0;
    while (!document.querySelector("ytd-playlist-video-renderer") && waited < 5000) {
      await sleep(200);
      waited += 200;
      if (!isPlaylistPage()) return; // 그 사이 페이지 이동
    }
    await loadPendingMoved();
    // 이미 화면에 로드돼 있으면 공짜로 그 자리를 보여 준다 (추가 로딩 없음)
    if (pendingMoved) {
      const it = findItemByVideoId(pendingMoved);
      if (it) {
        flashItem(it);
        clearPendingMoved();
      }
    }
    render();
    measureDock(); // 패널을 ⋮ 열 왼쪽에 붙인다 (1회 측정)

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

  // 유튜브는 새로고침 없이 이동 → yt-navigate-finish 로 재초기화
  window.addEventListener("yt-navigate-finish", () => {
    // 약간의 지연 후 (DOM 갱신 대기)
    setTimeout(() => init(), 150);
  });

  // 최초 진입
  init();
})();
