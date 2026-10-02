// tools/smoke-test.js — 확장을 실제 크로미움에 로드해 동작을 확인한다.
//
//   npm i -g playwright && npx playwright install chromium
//   node tools/smoke-test.js
//   (크로미움을 직접 지정할 때: CHROMIUM_PATH=/경로/chrome node tools/smoke-test.js)
//
// youtube.com 요청을 가짜 재생목록 페이지로 가로채서, content script 가 실제로
// 주입되는 조건(https://www.youtube.com/playlist?list=...)을 그대로 만든다.
// 실패하면 종료 코드 1.
const { chromium } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EXT = path.resolve(__dirname, "..");

function rows(from, to) {
  let h = "";
  for (let i = from; i < to; i++) {
    const vid = "vid" + String(i).padStart(5, "0");
    h += `<ytd-playlist-video-renderer class="style-scope">
      <div id="index">${i + 1}</div>
      <a id="thumbnail" href="/watch?v=${vid}&list=PLTEST&index=${i + 1}"></a>
      <a id="video-title" href="/watch?v=${vid}&list=PLTEST&index=${i + 1}">노래 ${i} Song${i}</a>
      <ytd-channel-name>가수${i % 7}</ytd-channel-name>
      <div id="reorder">≡</div>
    </ytd-playlist-video-renderer>`;
  }
  return h;
}

const PAGE = (n) => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>테스트 재생목록 - YouTube</title>
<style>
  body{background:#0f0f0f;color:#fff;margin:0;font-family:sans-serif}
  ytd-playlist-video-renderer{display:flex;gap:8px;align-items:center;height:60px;
    border-bottom:1px solid #222;padding:0 8px}
  a{color:#fff;text-decoration:none}
  ytd-playlist-header-renderer{display:block}
  #page-header{height:200px;background:#181818;margin-left:520px}
  #list{margin-left:520px;max-width:760px}
</style></head><body>
<ytd-playlist-header-renderer id="page-header"><h1>테스트 재생목록</h1></ytd-playlist-header-renderer>
<div id="list">${rows(0, n)}</div>
</body></html>`;

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytpd-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  let pass = 0, fail = 0;
  const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (extra ? " — " + extra : "")); }
  };

  const page = await ctx.newPage();
  page.on("pageerror", (e) => { fail++; console.log("  FAIL  page error: " + e.message); });
  page.on("console", (m) => { if (m.type() === "error") console.log("  (console error) " + m.text()); });

  await page.route("https://www.youtube.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: PAGE(300) })
  );

  // 서비스 워커가 뜨면 확장 ID 를 알 수 있다 (팝업 페이지 주소용)
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extUrl = sw.url().replace(/background\.js$/, "");

  await page.goto("https://www.youtube.com/playlist?list=PLTEST");
  await page.waitForSelector("#ytpd-panel", { timeout: 15000 });
  ok("패널이 뜬다", true);

  ok("패널 기본 위치 = 오른쪽 위",
    await page.$eval("#ytpd-panel", (el) => el.classList.contains("ytpd-pos-tr")));

  // ---- hover 도구막대 -------------------------------------------------------
  const row5 = page.locator("ytd-playlist-video-renderer").nth(5);
  await row5.hover();
  await page.waitForSelector(".ytpd-item-tools", { state: "visible", timeout: 5000 });
  ok("hover 하면 ＋북마크/↦북마크 도구막대가 뜬다", true);

  // 도구막대가 유튜브 ⋮ 열(오른쪽 끝 60px)을 덮지 않는지
  const geo = await page.evaluate(() => {
    const tb = document.querySelector(".ytpd-item-tools").getBoundingClientRect();
    const it = document.querySelectorAll("ytd-playlist-video-renderer")[5].getBoundingClientRect();
    return { tbRight: tb.right, itRight: it.right };
  });
  ok("도구막대가 ⋮ 열 왼쪽에 있다", geo.tbRight <= geo.itRight - 55 + 1,
     `tbRight=${geo.tbRight} itRight=${geo.itRight}`);

  // 패널과 세로로 겹치는 줄에서는 도구막대가 패널 왼쪽으로 밀려야 한다
  const over = await page.evaluate(() => {
    const panel = document.querySelector("#ytpd-panel").getBoundingClientRect();
    const items = [...document.querySelectorAll("ytd-playlist-video-renderer")];
    const hit = items.find((it) => {
      const r = it.getBoundingClientRect();
      return r.top > panel.top + 10 && r.top < panel.bottom - 40;
    });
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    hit.dispatchEvent(new PointerEvent("pointerover", {
      bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
    const tb = document.querySelector(".ytpd-item-tools").getBoundingClientRect();
    return { tbRight: tb.right, panelLeft: panel.left };
  });
  ok("패널과 겹치는 줄에서는 도구막대가 패널 왼쪽으로 밀린다",
     over && over.tbRight <= over.panelLeft + 1, JSON.stringify(over));

  // ---- 북마크 추가 ----------------------------------------------------------
  await page.evaluate(() => window.scrollTo(0, 0));
  // 마우스가 이미 5번 줄 위에 있으면 브라우저가 pointerover 를 새로 쏘지 않는다.
  // 실제 사용처럼 "바깥에서 줄 위로 들어오는" 움직임을 만든다.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  await row5.hover(); // 위 검사에서 hover 대상이 바뀌었다
  await page.waitForTimeout(300);
  const aim = await page.evaluate(() => {
    const it = document.querySelectorAll("ytd-playlist-video-renderer")[5].getBoundingClientRect();
    const tb = document.querySelector(".ytpd-item-tools").getBoundingClientRect();
    return { itTop: Math.round(it.top), itBottom: Math.round(it.bottom), tbTop: Math.round(tb.top) };
  });
  ok("도구막대가 마우스를 올린 줄에 붙는다",
     aim.tbTop >= aim.itTop && aim.tbTop < aim.itBottom, JSON.stringify(aim));
  await page.click(".ytpd-item-tools button:has-text('＋북마크')");
  await page.waitForSelector(".ytpd-modal-input", { timeout: 5000 });
  await page.fill(".ytpd-modal-input", "1장");
  await page.press(".ytpd-modal-input", "Enter");
  await page.waitForSelector("#ytpd-panel .ytpd-row-name:has-text('1장')", { timeout: 5000 });
  ok("북마크가 패널에 추가된다", true);
  const stored = await sw.evaluate(() => new Promise((r) =>
    chrome.storage.local.get(["pl:PLTEST"], (x) => r(JSON.stringify(x["pl:PLTEST"])))));
  console.log("       저장된 북마크: " + stored);
  ok("모달이 닫히면 스크롤 잠금이 풀린다",
    !(await page.evaluate(() => document.documentElement.classList.contains("ytpd-modal-open"))));

  // ---- 점프 ----------------------------------------------------------------
  await page.evaluate(() => window.scrollTo(0, 3000));
  await page.click("#ytpd-panel .ytpd-row-name:has-text('1장')");
  await page.waitForTimeout(600);
  const flashInfo = await page.evaluate(() => {
    const f = document.querySelectorAll(".ytpd-flash");
    return { n: f.length, hrefs: [...f].map((x) => (x.querySelector("a#video-title")||{getAttribute:()=>"?"}).getAttribute("href")) };
  });
  ok("북마크를 누르면 그 영상이 강조된다",
     flashInfo.n === 1 && String(flashInfo.hrefs[0]).includes("v=vid00005"), JSON.stringify(flashInfo));

  // ---- 검색 + 캐시 갱신(회귀) ----------------------------------------------
  await page.fill(".ytpd-search-input", "Song42");
  await page.waitForTimeout(400);
  ok("검색이 로드된 영상을 찾는다",
    (await page.textContent(".ytpd-search-status")).includes("있음"));

  await page.evaluate(() => {
    // 스크롤로 새 영상이 더 불려온 상황을 그대로 흉내 낸다
    const list = document.querySelector("#list");
    const d = document.createElement("div");
    d.innerHTML = `<ytd-playlist-video-renderer>
      <a id="video-title" href="/watch?v=vidNEW01&list=PLTEST">새로 불러온 노래 LateLoaded</a>
      <ytd-channel-name>새가수</ytd-channel-name></ytd-playlist-video-renderer>`;
    list.appendChild(d.firstElementChild);
  });
  await page.fill(".ytpd-search-input", "LateLoaded");
  await page.waitForTimeout(400);
  ok("스크롤로 새로 불러온 영상도 검색된다 (캐시 회귀)",
    (await page.textContent(".ytpd-search-status")).includes("있음"),
    await page.textContent(".ytpd-search-status"));
  await page.fill(".ytpd-search-input", "");
  await page.waitForTimeout(300);

  // ---- 패널 위치 ------------------------------------------------------------
  const posOf = () => page.evaluate(() => document.querySelector("#ytpd-panel").dataset.pos);
  const spots = [];
  for (let i = 0; i < 4; i++) {
    await page.click("#ytpd-panel .ytpd-pos");
    await page.waitForTimeout(350);
    const g = await page.evaluate(() => {
      const p = document.querySelector("#ytpd-panel").getBoundingClientRect();
      const it = document.querySelectorAll("ytd-playlist-video-renderer")[0].getBoundingClientRect();
      return { pos: document.querySelector("#ytpd-panel").dataset.pos, top: p.top, bottom: p.bottom,
               pRight: p.right, itLeft: it.left, pw: p.width, vh: innerHeight };
    });
    spots.push(g);
  }
  ok("위치 버튼 하나로 오른쪽 아래 → 왼쪽 위 → 왼쪽 아래 → 오른쪽 위 순으로 돈다",
     spots.map((g) => g.pos).join(",") === "br,tl,bl,tr", spots.map((g) => g.pos).join(","));
  ok("아래 위치는 화면 아래쪽에 붙는다", spots[0].bottom > spots[0].vh - 40 && spots[2].bottom > spots[2].vh - 40);
  ok("왼쪽에서 영상 목록과 안 겹친다", spots[1].pRight <= spots[1].itLeft + 1 && spots[2].pRight <= spots[2].itLeft + 1,
     `tl=${spots[1].pRight} bl=${spots[2].pRight} listLeft=${spots[1].itLeft}`);

  // ---- 접기/펼치기 ----------------------------------------------------------
  await page.click("#ytpd-panel .ytpd-toggle");
  await page.waitForTimeout(200);
  ok("접어도 ⤒ ⤓ 는 보인다",
    await page.isVisible("#ytpd-panel .ytpd-nav-top") && await page.isVisible("#ytpd-panel .ytpd-nav-end"));
  await page.click("#ytpd-panel .ytpd-toggle");
  await page.waitForTimeout(200);

  // ---- 팝업 토글 끄기→켜기 (도구막대 회귀) ---------------------------------
  const popup = await ctx.newPage();
  await popup.goto(extUrl + "popup.html");
  await popup.click(".slider");
  ok("팝업 토글이 꺼진다", !(await popup.isChecked("#toggle")));
  await page.bringToFront();
  await page.waitForTimeout(600);
  ok("끄면 패널이 사라진다", !(await page.isVisible("#ytpd-panel")));
  ok("끄면 도구막대도 페이지에서 사라진다", (await page.$(".ytpd-item-tools")) === null);

  await popup.bringToFront();
  await popup.click(".slider");
  ok("팝업 토글이 다시 켜진다", await popup.isChecked("#toggle"));
  // 팝업 ⚙ — 유튜브 탭이 아닌 곳(여기선 팝업 자신)에서 누르면 안내만 뜬다
  await popup.click("#settings");
  await popup.waitForTimeout(200);
  ok("유튜브 탭이 아니면 ⚙ 가 안내 문구를 띄운다", await popup.isVisible("#setHint"));
  await page.bringToFront();
  await page.waitForTimeout(900);
  ok("다시 켜면 패널이 돌아온다", await page.isVisible("#ytpd-panel"));
  await page.evaluate(() => document.querySelectorAll("ytd-playlist-video-renderer")[9]
    .scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  const dbg9 = await page.evaluate(() => {
    const it = document.querySelectorAll("ytd-playlist-video-renderer")[9];
    const r = it.getBoundingClientRect();
    it.dispatchEvent(new PointerEvent("pointerover", {
      bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
    const t = document.querySelector(".ytpd-item-tools");
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width),
             display: t && t.style.display };
  });
  await page.waitForTimeout(300);
  const tbState = await page.evaluate(() => {
    const t = document.querySelector(".ytpd-item-tools");
    return t ? { inDom: true, display: t.style.display, connected: t.isConnected } : { inDom: false };
  });
  ok("다시 켜면 hover 도구막대도 돌아온다 (회귀)", await page.isVisible(".ytpd-item-tools"),
     JSON.stringify(tbState) + " dbg9=" + JSON.stringify(dbg9));

  // ---- 설정 모달 ------------------------------------------------------------
  ok("패널 헤더에는 더 이상 ⚙ 가 없다", !(await page.$("#ytpd-panel .ytpd-set")));
  // 실제 팝업은 활성 탭에 메시지를 보낸다. 테스트에선 팝업이 탭으로 열려 있으므로
  // 유튜브 탭을 앞으로 가져온 뒤 팝업 페이지 안에서 ⚙ 버튼을 누른다.
  await page.bringToFront();
  await popup.evaluate(() => document.getElementById("settings").click());
  await page.waitForSelector(".ytpd-modal-wide", { timeout: 5000 });
  ok("팝업의 ⚙ 로 설정 모달이 열린다", true);
  ok("로그인 상태 문구에 이벤트 객체가 안 들어간다 (회귀)",
    !(await page.textContent(".ytpd-set-status")).includes("PointerEvent"),
    await page.textContent(".ytpd-set-status"));
  ok("📖 사용법은 접힌 채로 열린다",
    !(await page.$eval(".ytpd-guide", (el) => el.hasAttribute("open"))));
  await page.click(".ytpd-guide > summary");
  await page.waitForTimeout(200);
  ok("사용법을 누르면 펼쳐진다", await page.$eval(".ytpd-guide", (el) => el.hasAttribute("open")));
  await page.click(".ytpd-modal-wide [data-close]");
  await page.waitForTimeout(200);
  ok("설정을 닫으면 스크롤 잠금이 풀린다",
    !(await page.evaluate(() => document.documentElement.classList.contains("ytpd-modal-open"))));

  // ---- 좁은 창 ---------------------------------------------------------------
  await page.setViewportSize({ width: 780, height: 800 });
  await page.waitForTimeout(500);
  const narrow = await page.evaluate(() => {
    const p = document.querySelector("#ytpd-panel").getBoundingClientRect();
    return { left: p.left, right: p.right, vw: document.documentElement.clientWidth };
  });
  ok("좁은 창에서도 패널이 화면 안에 있다", narrow.left >= -1 && narrow.right <= narrow.vw + 1,
     JSON.stringify(narrow));
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- hover 성능 (느린 CPU 흉내: 6배 스로틀) --------------------------------
  const client = await ctx.newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  const perf = await page.evaluate(async () => {
    const items = document.querySelectorAll("ytd-playlist-video-renderer");
    const t0 = performance.now();
    for (let i = 0; i < 120; i++) {
      const it = items[i % items.length];
      const r = it.getBoundingClientRect();
      it.dispatchEvent(new PointerEvent("pointerover", {
        bubbles: true, clientX: r.left + 5, clientY: r.top + 5,
      }));
    }
    return performance.now() - t0;
  });
  await client.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  console.log(`  hover 120회 (CPU 6배 느리게): ${perf.toFixed(1)}ms  = ${(perf / 120).toFixed(2)}ms/회`);
  ok("느린 CPU 에서도 hover 가 프레임을 안 잡아먹는다 (<4ms/회)", perf / 120 < 4);

  await ctx.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
