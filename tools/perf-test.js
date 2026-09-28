// tools/perf-test.js — 긴 재생목록(3000개)에서 렉을 잰다.
//
//   node tools/perf-test.js
//   (크로미움을 직접 지정할 때: CHROMIUM_PATH=/경로/chrome node tools/perf-test.js)
//
// CPU 를 6배 느리게 걸어 "느린 PC" 에 가깝게 만든 뒤, 확장을 넣었을 때와 뺐을 때를
// 같은 방법으로 재서 나란히 보여 준다. 스크롤 프레임 간격이 기준이다.
const { chromium } = require("playwright");
const path = require("path"), os = require("os"), fs = require("fs");
const EXT = path.resolve(__dirname, "..");
const N = 3000;

function body() {
  let h = "";
  for (let i = 0; i < N; i++) {
    const v = "vid" + String(i).padStart(5, "0");
    h += `<ytd-playlist-video-renderer><a id="thumbnail" href="/watch?v=${v}"></a>` +
         `<a id="video-title" href="/watch?v=${v}">노래 ${i} Song${i}</a>` +
         `<ytd-channel-name>가수${i % 37}</ytd-channel-name></ytd-playlist-video-renderer>`;
  }
  return h;
}
const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>T - YouTube</title>
<style>body{background:#0f0f0f;color:#fff;margin:0}
ytd-playlist-header-renderer{display:block}
ytd-playlist-video-renderer{display:flex;height:60px;border-bottom:1px solid #222}
#page-header{height:200px;background:#181818;margin-left:520px}
#list{margin-left:520px;max-width:760px}</style></head><body>
<ytd-playlist-header-renderer id="page-header"><h1>긴 재생목록</h1></ytd-playlist-header-renderer>
<div id="list">${body()}</div></body></html>`;

async function run(withExt) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "ytpd-perf-"));
  const args = withExt
    ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    : [];
  const ctx = await chromium.launchPersistentContext(ud, {
    headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args,
  });
  const page = await ctx.newPage();
  await page.route("https://www.youtube.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: PAGE }));

  const t0 = Date.now();
  await page.goto("https://www.youtube.com/playlist?list=PLBIG");
  if (withExt) await page.waitForSelector("#ytpd-panel", { timeout: 30000 });
  const load = Date.now() - t0;

  const client = await ctx.newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  await page.waitForTimeout(500);

  // 스크롤 끊김: 40번 스크롤하며 프레임 간격을 잰다
  const scroll = await page.evaluate(async () => {
    const frames = [];
    let last = performance.now();
    let stop = false;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    for (let i = 0; i < 40; i++) {
      window.scrollBy(0, 600);
      await new Promise((r) => setTimeout(r, 50));
    }
    stop = true;
    await new Promise((r) => setTimeout(r, 100));
    frames.sort((a, b) => a - b);
    return {
      median: frames[Math.floor(frames.length / 2)],
      p95: frames[Math.floor(frames.length * 0.95)],
      worst: frames[frames.length - 1],
      long: frames.filter((f) => f > 50).length,
    };
  });

  // hover 120회
  const hover = await page.evaluate(() => {
    const items = document.querySelectorAll("ytd-playlist-video-renderer");
    const t = performance.now();
    for (let i = 0; i < 120; i++) {
      const it = items[i * 7 % items.length];
      const r = it.getBoundingClientRect();
      it.dispatchEvent(new PointerEvent("pointerover", {
        bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
    }
    return performance.now() - t;
  });

  let search = null;
  if (withExt) {
    await page.fill(".ytpd-search-input", "Song2500");
    const t = Date.now();
    await page.waitForFunction(
      () => (document.querySelector(".ytpd-search-status")?.textContent || "").includes("있음"),
      { timeout: 20000 });
    search = Date.now() - t;
  }

  await ctx.close();
  return { load, scroll, hover, search };
}

(async () => {
  const off = await run(false);
  const on = await run(true);
  const f = (x) => x.toFixed(1);
  console.log(`영상 ${N}개 · CPU 6배 느리게\n`);
  console.log(`                        확장 없음      확장 있음`);
  console.log(`페이지 로드              ${off.load}ms        ${on.load}ms`);
  console.log(`스크롤 프레임 중앙값     ${f(off.scroll.median)}ms        ${f(on.scroll.median)}ms`);
  console.log(`스크롤 프레임 p95        ${f(off.scroll.p95)}ms        ${f(on.scroll.p95)}ms`);
  console.log(`50ms 넘게 멈춘 프레임    ${off.scroll.long}개          ${on.scroll.long}개`);
  console.log(`hover 120회              ${f(off.hover)}ms        ${f(on.hover)}ms`);
  if (on.search != null) console.log(`검색(2500번째 곡)        -             ${on.search}ms`);
})();
