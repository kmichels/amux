/**
 * pw-profiles-e2e.js
 * E2E test: profile management, login URL form, state dot, recording metadata
 */
const { chromium } = require('playwright');
const { homedir } = require('os');
const fs = require('fs');
const path = require('path');

const PROFILE_NAME = 'e2e-test-profile';

(async () => {
  const ctx = await chromium.launchPersistentContext(
    `${homedir()}/.amux/playwright-auth/profile`,
    { headless: true, viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true }
  );
  const page = await ctx.newPage();
  await page.goto('https://localhost:8822', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(1500);

  // ── 1. /api/browser/profiles has has_state ────────────────────────────────
  const profilesData = await page.evaluate(async () => {
    const r = await fetch('/api/browser/profiles');
    return r.json();
  });
  const defaultProf = profilesData.profiles?.find(p => p.name === 'default');
  console.log('1. /api/browser/profiles:', JSON.stringify({
    count: profilesData.profiles?.length,
    defaultHasState: defaultProf?.has_state,
    hasStateField: 'has_state' in (defaultProf || {}),
  }));

  // ── 2. Navigate to Browser tab ───────────────────────────────────────────
  await page.locator('#tab-browser').click();
  await page.waitForTimeout(500);

  // ── 3. Check profile state dot ───────────────────────────────────────────
  const dotState = await page.evaluate(() => {
    const dot = document.getElementById('rb-profile-state');
    return { found: !!dot, text: dot?.textContent, title: dot?.title };
  });
  console.log('2. Profile state dot:', JSON.stringify(dotState));

  // ── 4. Check Login button shows URL form ─────────────────────────────────
  const loginBtn = page.locator('#rb-login-btn');
  await loginBtn.click();
  await page.waitForTimeout(300);
  const loginFormState = await page.evaluate(() => {
    const form = document.getElementById('rb-login-url-form');
    const inp = document.getElementById('rb-login-url');
    const loginBtn = document.getElementById('rb-login-btn');
    return {
      formVisible: form?.style?.display !== 'none',
      inputFound: !!inp,
      placeholder: inp?.placeholder,
      loginBtnHidden: loginBtn?.style?.display === 'none',
    };
  });
  console.log('3. Login URL form:', JSON.stringify(loginFormState));
  await page.screenshot({ path: '/tmp/prof-e2e-01-login-form.png' });

  // Dismiss the login form
  await page.locator('#rb-login-url-form .btn').filter({ hasText: '✕' }).click();
  await page.waitForTimeout(200);

  // ── 5. Create a test profile ─────────────────────────────────────────────
  await page.locator('#rb-new-btn').click();
  await page.waitForTimeout(200);
  await page.locator('#rb-new-profile-name').fill(PROFILE_NAME);
  await page.locator('#rb-new-profile-form .btn.primary').click();
  await page.waitForTimeout(500);

  const profileCreated = await page.evaluate((name) => {
    const sel = document.getElementById('rb-profile');
    const opts = [...sel.options].map(o => o.value);
    return { found: opts.includes(name), options: opts };
  }, PROFILE_NAME);
  console.log('4. Profile created:', JSON.stringify(profileCreated));

  // ── 6. Switch to test profile and check state dot updates ────────────────
  await page.locator('#rb-profile').selectOption(PROFILE_NAME);
  await page.waitForTimeout(600);
  const dotAfterSwitch = await page.evaluate(() => {
    const dot = document.getElementById('rb-profile-state');
    return { text: dot?.textContent, title: dot?.title };
  });
  console.log('5. Dot after switch to new profile:', JSON.stringify(dotAfterSwitch));

  // ── 7. Check /api/recordings includes profile field ──────────────────────
  const recsData = await page.evaluate(async () => {
    const r = await fetch('/api/recordings');
    return r.json();
  });
  const newestRec = recsData.recordings?.[0];
  console.log('6. /api/recordings newest entry:', JSON.stringify({
    name: newestRec?.name,
    hasProfileField: 'profile' in (newestRec || {}),
    profile: newestRec?.profile,
    hasTaskField: 'task' in (newestRec || {}),
    task: newestRec?.task,
  }));

  // ── 8. Check .json sidecar on newest recording ───────────────────────────
  if (newestRec?.path) {
    const jsonPath = newestRec.path.replace(/\.\w+$/, '.json');
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch(e) {}
    console.log('7. .json sidecar:', JSON.stringify({ path: jsonPath, exists: !!meta, meta }));
  }

  // ── 9. Open newest recording in viewer and check profile in metadata bar ─
  await page.locator('#browser-view .btn').filter({ hasText: 'Recordings' }).click();
  await page.waitForTimeout(800);
  await page.locator('#explore-body .explore-row').filter({ hasText: newestRec?.name }).click();
  await page.waitForTimeout(1500);
  const viewerMeta = await page.evaluate(() => {
    const meta = document.querySelector('#file-body .file-video-meta');
    return { text: meta?.textContent?.trim()?.replace(/\s+/g, ' ') };
  });
  console.log('8. Video viewer meta bar:', JSON.stringify(viewerMeta));
  await page.screenshot({ path: '/tmp/prof-e2e-02-video-meta.png' });

  // ── 10. Clean up test profile ────────────────────────────────────────────
  await page.locator('#file-overlay .btn').filter({ hasText: '✕' }).first().click();
  await page.waitForTimeout(200);
  await page.locator('#rb-profile').selectOption('default');
  await page.waitForTimeout(400);
  const delBtn = page.locator('#rb-del-profile');
  // Switch back to test profile to delete it
  await page.locator('#rb-profile').selectOption(PROFILE_NAME);
  await page.waitForTimeout(400);
  // Use API to delete quietly (avoid confirm dialog)
  await page.evaluate(async (name) => {
    await fetch('/api/browser/profiles/' + encodeURIComponent(name), { method: 'DELETE' });
  }, PROFILE_NAME);
  await page.waitForTimeout(300);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n━━━ Results ━━━');
  console.log(`has_state in profiles API:  ${dotState.found && 'has_state' in (defaultProf || {}) ? '✓' : '✗'}`);
  console.log(`State dot present:          ${dotState.found ? '✓ "' + dotState.text + '"' : '✗'}`);
  console.log(`Default profile has state:  ${defaultProf?.has_state ? '✓ (🟢 logged in)' : '✗ (⚪ not logged in)'}`);
  console.log(`Login URL form shows:       ${loginFormState.formVisible ? '✓' : '✗'}`);
  console.log(`URL input placeholder:      ${loginFormState.placeholder || '✗'}`);
  console.log(`Login btn hides on form:    ${loginFormState.loginBtnHidden ? '✓' : '✗'}`);
  console.log(`Profile created:            ${profileCreated.found ? '✓' : '✗'}`);
  console.log(`Dot updates on switch:      ${dotAfterSwitch.text ? '✓ "' + dotAfterSwitch.text + '"' : '✗'}`);
  console.log(`Recordings have profile:    ${'profile' in (newestRec || {}) ? '✓ "' + newestRec?.profile + '"' : '✗'}`);
  console.log(`Recordings have task:       ${'task' in (newestRec || {}) ? '✓' : '✗'}`);
  console.log(`Video meta bar:             ${viewerMeta.text ? '✓ ' + viewerMeta.text.substring(0, 80) : '✗'}`);
  console.log('\nScreenshots: /tmp/prof-e2e-*.png');

  await ctx.close();
})();
