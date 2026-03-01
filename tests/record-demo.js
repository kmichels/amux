/**
 * record-demo.js — End-to-end browser recording demo for amux
 *
 * Records a multi-page browser session with:
 *  - Persistent profile (credentials/cookies saved across runs)
 *  - Visible DOM cursor that shows in video
 *  - Click ripple indicators (orange circles at click locations)
 *  - Ghost-cursor smooth Bezier mouse movement
 *  - Per-segment captions logged with timestamps
 *  - ffmpeg post-process: WebM → MP4 with burned-in SRT captions
 *
 * Usage:
 *   node tests/record-demo.js [profile-name]
 *   node tests/record-demo.js gmail      ← uses ~/.amux/playwright-auth/profiles/gmail/
 *   node tests/record-demo.js            ← uses default profile
 */

const { chromium } = require('playwright');
const { homedir } = require('os');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Paths ─────────────────────────────────────────────────────────────────
const PROFILE_ARG = process.argv[2] || 'default';
const PROFILES_DIR = `${homedir()}/.amux/playwright-auth/profiles`;
const DEFAULT_PROFILE = `${homedir()}/.amux/playwright-auth/profile`;
const VIDEOS_DIR = `${homedir()}/.amux/browser-videos`;
const OUTPUT_DIR = `${homedir()}/.amux/recordings`;

const profilePath = PROFILE_ARG === 'default'
  ? DEFAULT_PROFILE
  : `${PROFILES_DIR}/${PROFILE_ARG.replace(/[^a-zA-Z0-9_-]/g, '')}`;

// ─── Caption system ─────────────────────────────────────────────────────────
const captions = [];
let recordingStartMs = 0;

function addCaption(text, durationMs = 3500) {
  const startMs = Date.now() - recordingStartMs;
  const endMs = startMs + durationMs;
  captions.push({ start: startMs, end: endMs, text });
  const ts = (startMs / 1000).toFixed(1);
  console.log(`  [${ts}s] 💬 ${text}`);
}

function msToSrtTimecode(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mil = ms % 1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(mil).padStart(3,'0')}`;
}

function writeSrt(filePath) {
  const lines = captions.map((c, i) =>
    `${i + 1}\n${msToSrtTimecode(c.start)} --> ${msToSrtTimecode(c.end)}\n${c.text}`
  );
  fs.writeFileSync(filePath, lines.join('\n\n') + '\n');
  console.log(`  SRT → ${filePath}`);
}

// ─── Injected scripts: visible cursor + click ripple ────────────────────────
// Injected via ctx.addInitScript() — runs on every page load in this context.
// Both elements are DOM nodes so they appear in Playwright's recordVideo output.
const CURSOR_AND_RIPPLE_SCRIPT = `
(function() {
  'use strict';

  // ── Visible cursor ──────────────────────────────────────────────────────
  // A fixed <div> that follows mousemove. Shows cursor position in headless video.
  const CURSOR_ID = '__amux_cursor__';

  function attachCursor() {
    if (document.getElementById(CURSOR_ID)) return;
    const el = document.createElement('div');
    el.id = CURSOR_ID;
    el.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:2147483647',
      'width:20px', 'height:20px', 'border-radius:50%',
      'border:2.5px solid rgba(255,80,0,0.92)',
      'background:rgba(255,80,0,0.18)',
      'transform:translate(-50%,-50%)',
      'transition:left 0.06s linear,top 0.06s linear',
      'box-shadow:0 0 0 3px rgba(255,80,0,0.22)',
      'left:-100px', 'top:-100px',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  let cursorEl = null;
  document.addEventListener('mousemove', (e) => {
    if (!cursorEl) cursorEl = attachCursor();
    if (cursorEl) {
      cursorEl.style.left = e.clientX + 'px';
      cursorEl.style.top  = e.clientY + 'px';
    }
  }, { capture: true, passive: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { cursorEl = attachCursor(); });
  } else {
    cursorEl = attachCursor();
  }

  // ── Click ripple ────────────────────────────────────────────────────────
  // Orange expanding circle at every click location.
  const RIPPLE_CSS = '@keyframes __amux_ripple{' +
    '0%{transform:translate(-50%,-50%) scale(0.2);opacity:1}' +
    '100%{transform:translate(-50%,-50%) scale(2.8);opacity:0}}';
  const styleEl = document.createElement('style');
  styleEl.textContent = RIPPLE_CSS;
  (document.head || document.documentElement).appendChild(styleEl);

  document.addEventListener('click', (e) => {
    const ripple = document.createElement('div');
    ripple.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:2147483646',
      'width:44px', 'height:44px', 'border-radius:50%',
      'background:rgba(255,140,0,0.50)',
      'border:3px solid rgba(255,140,0,0.88)',
      'left:' + e.clientX + 'px',
      'top:'  + e.clientY + 'px',
      'animation:__amux_ripple 0.65s ease-out forwards',
    ].join(';');
    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 750);
  }, { capture: true, passive: true });

})();
`;

// ─── Ghost cursor helper ─────────────────────────────────────────────────────
// Wraps ghost-cursor-playwright; falls back to stepped interpolation if absent.
let _ghostCursorModule = null;
try {
  _ghostCursorModule = require(
    path.resolve(__dirname, '../node_modules/ghost-cursor-playwright')
  );
  console.log('✓ ghost-cursor-playwright loaded (smooth Bezier movement)');
} catch (e) {
  console.log('  ghost-cursor-playwright not found — using linear interpolation');
}

async function makeGhostCursor(page) {
  if (_ghostCursorModule && _ghostCursorModule.createCursor) {
    const cursor = await _ghostCursorModule.createCursor(page);
    return {
      async moveTo(x, y) {
        await cursor.actions.move({ x, y });
      },
      async click(x, y) {
        await cursor.actions.move({ x, y });
        await page.mouse.click(x, y);
      },
    };
  }
  // Fallback: linear interpolation
  let cx = 640, cy = 400;
  return {
    async moveTo(x, y) {
      const steps = 18;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(
          cx + (x - cx) * (i / steps),
          cy + (y - cy) * (i / steps)
        );
        await page.waitForTimeout(16); // ~60fps
      }
      cx = x; cy = y;
    },
    async click(x, y) {
      await this.moveTo(x, y);
      await page.waitForTimeout(80);
      await page.mouse.click(x, y);
      cx = x; cy = y;
    },
  };
}

// ─── Main recording ──────────────────────────────────────────────────────────
(async () => {
  console.log('\n━━━ amux Browser Recording Demo ━━━');
  console.log(`  Profile : ${profilePath}`);
  console.log(`  Videos  : ${VIDEOS_DIR}`);
  console.log(`  Output  : ${OUTPUT_DIR}\n`);

  fs.mkdirSync(VIDEOS_DIR,  { recursive: true });
  fs.mkdirSync(OUTPUT_DIR,  { recursive: true });
  fs.mkdirSync(profilePath, { recursive: true });

  // ── Launch persistent context with recordVideo ──────────────────────────
  const ctx = await chromium.launchPersistentContext(profilePath, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    recordVideo: { dir: VIDEOS_DIR, size: { width: 1280, height: 800 } },
    args: [
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
      '--force-device-scale-factor=1',
    ],
  });

  // Inject cursor + ripple into every page in this context
  await ctx.addInitScript(CURSOR_AND_RIPPLE_SCRIPT);

  let page = ctx.pages()[0] || await ctx.newPage();
  const cursor = await makeGhostCursor(page);

  recordingStartMs = Date.now();
  console.log('● Recording started\n');

  async function snap(label) {
    const p = `/tmp/record-demo-${label}.png`;
    await page.screenshot({ path: p, fullPage: false });
    console.log(`  📸 ${p}`);
    return p;
  }

  async function pause(ms) { await page.waitForTimeout(ms); }

  // ════════════════════════════════════════════════════════════════════════
  // Step 1 — Playwright homepage
  // ════════════════════════════════════════════════════════════════════════
  addCaption('Opening the Playwright browser automation homepage');
  await page.goto('https://playwright.dev', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await pause(2500);
  await snap('01-playwright-home');

  // Move cursor to the hero CTA
  addCaption('Exploring Playwright\'s hero section and key benefits');
  await cursor.moveTo(640, 300);
  await pause(800);
  await cursor.moveTo(400, 450);
  await pause(600);

  // Scroll down to see features
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 500);
  await pause(1200);
  await page.mouse.wheel(0, 500);
  await pause(1200);
  await snap('02-playwright-features');

  // ════════════════════════════════════════════════════════════════════════
  // Step 2 — Click Docs
  // ════════════════════════════════════════════════════════════════════════
  addCaption('Clicking into the Playwright documentation');
  // Scroll back to top to find the nav
  await page.mouse.wheel(0, -1200);
  await pause(800);

  // Find and click "Docs" in the navbar
  const docsLink = await page.$('a[href*="/docs/intro"], a:text("Docs"), nav a:text("Get started")');
  if (docsLink) {
    const box = await docsLink.boundingBox();
    if (box) {
      await cursor.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await pause(2000);
    }
  }
  await snap('03-playwright-docs');

  // ════════════════════════════════════════════════════════════════════════
  // Step 3 — GitHub repo
  // ════════════════════════════════════════════════════════════════════════
  addCaption('Navigating to the Playwright GitHub repository');
  await page.goto('https://github.com/microsoft/playwright', {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
  await pause(2500);
  await snap('04-github-playwright');

  // Move cursor around to show it's alive
  addCaption('Reviewing the open-source repository — 67k+ stars on GitHub');
  await cursor.moveTo(640, 200);
  await pause(500);
  await cursor.moveTo(900, 350);
  await pause(500);

  // Scroll through the README
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 600);
  await pause(1500);
  await page.mouse.wheel(0, 600);
  await pause(1500);
  await snap('05-github-readme');

  // Click the star button area (just move to it — not actually clicking to avoid auth)
  addCaption('Exploring the repository structure and contributors');
  await cursor.moveTo(1050, 130);
  await pause(700);
  await cursor.moveTo(640, 400);
  await pause(500);

  // Scroll more
  await page.mouse.wheel(0, 800);
  await pause(1800);
  await snap('06-github-scroll');

  // ════════════════════════════════════════════════════════════════════════
  // Step 4 — Wikipedia
  // ════════════════════════════════════════════════════════════════════════
  addCaption('Looking up browser automation on Wikipedia');
  await page.goto('https://en.wikipedia.org/wiki/Playwright_(software)', {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
  await pause(2500);
  await snap('07-wikipedia-playwright');

  addCaption('Reading about Playwright\'s history, architecture, and ecosystem');
  await cursor.moveTo(500, 300);
  await pause(600);
  await page.mouse.wheel(0, 500);
  await pause(1200);
  await cursor.moveTo(700, 450);
  await pause(500);
  await page.mouse.wheel(0, 500);
  await pause(1200);
  await snap('08-wikipedia-scroll');

  // Click a reference link on Wikipedia
  addCaption('Clicking a reference link to explore related content');
  const wikiLink = await page.$('#mw-content-text a[href^="/wiki/"]:not([href*=":"]):not([href*="Main"])');
  if (wikiLink) {
    const box = await wikiLink.boundingBox();
    if (box && box.y > 200) {
      await cursor.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await pause(2000);
      await snap('09-wikipedia-linked');
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Step 5 — Wrap up
  // ════════════════════════════════════════════════════════════════════════
  addCaption('Recording complete — amux browser recording with profiles, captions & click indicators');
  await cursor.moveTo(640, 400);
  await pause(2500);

  // ── Close context and get video path ────────────────────────────────────
  const vid = page.video();
  console.log('\n● Stopping recording...');
  await ctx.close();

  const webmPath = vid ? await vid.path() : null;
  console.log(`  WebM: ${webmPath}`);

  if (!webmPath || !fs.existsSync(webmPath)) {
    console.error('  ✗ No WebM file found — recording may have failed');
    process.exit(1);
  }

  const webmSize = fs.statSync(webmPath).size;
  console.log(`  Size: ${(webmSize / 1024).toFixed(0)} KB`);

  // ── Generate SRT ─────────────────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const srtPath = `${OUTPUT_DIR}/demo-${timestamp}.srt`;
  const mp4Path = `${OUTPUT_DIR}/demo-${timestamp}.mp4`;
  const mp4NoSub = `${OUTPUT_DIR}/demo-${timestamp}-nosubs.mp4`;
  writeSrt(srtPath);

  // ── ffmpeg: WebM → MP4 with burned-in captions ──────────────────────────
  console.log('\n● Running ffmpeg...');

  // Step A: WebM → MP4 with subtitle burn-in
  // The subtitles filter uses libass (confirmed available in this ffmpeg build).
  // We escape the SRT path for ffmpeg's filter string.
  const srtEscaped = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  // force_style must be a single string — splitting across join(':') breaks option parsing
  const subtitleFilter = `subtitles='${srtEscaped}':force_style='FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=40'`;

  const ffResult = spawnSync('ffmpeg', [
    '-i', webmPath,
    '-vf', subtitleFilter,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-y', mp4Path,
  ], { encoding: 'utf8', timeout: 120_000 });

  if (ffResult.status === 0 && fs.existsSync(mp4Path)) {
    const mp4Size = fs.statSync(mp4Path).size;
    console.log(`  ✓ MP4 with captions → ${mp4Path}`);
    console.log(`  Size: ${(mp4Size / 1024 / 1024).toFixed(1)} MB`);
  } else {
    console.error('  ✗ ffmpeg with subtitles failed:');
    if (ffResult.stderr) console.error(ffResult.stderr.slice(-1000));

    // Fallback: convert without caption burn-in
    console.log('  Trying fallback (no subtitle burn-in)...');
    const ffFallback = spawnSync('ffmpeg', [
      '-i', webmPath,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y', mp4NoSub,
    ], { encoding: 'utf8', timeout: 120_000 });

    if (ffFallback.status === 0 && fs.existsSync(mp4NoSub)) {
      console.log(`  ✓ MP4 (no subs) → ${mp4NoSub}`);
    } else {
      console.error('  ✗ Fallback also failed:', ffFallback.stderr?.slice(-500));
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n━━━ Done ━━━');
  console.log(`  Profile   : ${profilePath}`);
  console.log(`  WebM      : ${webmPath}`);
  console.log(`  SRT       : ${srtPath}`);
  if (fs.existsSync(mp4Path)) {
    console.log(`  MP4       : ${mp4Path}  ← final output`);
  } else if (fs.existsSync(mp4NoSub)) {
    console.log(`  MP4       : ${mp4NoSub}  ← no subs (ffmpeg subtitle error above)`);
  }

  const snaps = fs.readdirSync('/tmp').filter(f => f.startsWith('record-demo-')).sort();
  if (snaps.length) {
    console.log(`\n  Screenshots (${snaps.length}):`);
    snaps.forEach(f => console.log(`    /tmp/${f}`));
  }
  console.log('');
})();
