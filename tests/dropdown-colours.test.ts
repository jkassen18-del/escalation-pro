/**
 * Regression test for the unreadable dropdown list.
 *
 * A native <select> popup is drawn by the platform: it inherits the control's
 * text colour but not its background. With only the control styled, options
 * resolved to `background-color: rgba(0,0,0,0)` and the platform painted the
 * list white - so the dark theme's near-white option text vanished into it,
 * legible only on whichever row the pointer was over.
 *
 * The popup itself cannot be screenshotted, so the computed styles on the
 * <option> elements are the real check.
 *
 * Skipped unless playwright-core and a Chromium binary are both present, so
 * `npm test` stays dependency-free everywhere else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].filter((candidate): candidate is string => Boolean(candidate));

function findChromium(): string | null {
  return CHROMIUM_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function loadChromium() {
  const executablePath = findChromium();
  if (!executablePath) return null;
  try {
    const { chromium } = (await import('playwright-core')) as typeof import('playwright-core');
    return { chromium, executablePath };
  } catch {
    return null;
  }
}

/** The theme tokens the options are expected to resolve to. */
const THEMES = [
  { name: 'light', surface: 'rgb(255, 255, 255)', fg: 'rgb(26, 24, 21)', subtle: 'rgb(147, 141, 132)' },
  { name: 'dark', surface: 'rgb(25, 23, 20)', fg: 'rgb(237, 233, 227)', subtle: 'rgb(116, 110, 101)' },
];

test('dropdown options are readable in both themes', async (t) => {
  const launcher = await loadChromium();
  if (!launcher) return t.skip('playwright-core or Chromium is not available here');

  // Tailwind's directives need the real build, so only the token blocks and the
  // base rules under test are inlined.
  const css = fs
    .readFileSync(path.join(ROOT, 'src/index.css'), 'utf8')
    .replace(/@import[^;]+;/g, '')
    .replace(/@layer base \{/g, '')
    .replace(/@theme \{[\s\S]*?\n\}/g, '');

  const browser = await launcher.chromium.launch({ executablePath: launcher.executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body>` +
        `<select id="s"><option>Urgent</option><option>High</option><option disabled>Low</option></select>` +
        `</body></html>`,
    );

    for (const theme of THEMES) {
      await page.evaluate((name) => {
        document.documentElement.dataset.theme = name;
      }, theme.name);

      const options = await page.evaluate(() =>
        [...document.querySelectorAll('#s option')].map((option) => {
          const computed = getComputedStyle(option);
          return { background: computed.backgroundColor, color: computed.color };
        }),
      );

      assert.equal(options[0].background, theme.surface, `${theme.name}: option background`);
      assert.equal(options[0].color, theme.fg, `${theme.name}: option text`);
      assert.equal(options[2].color, theme.subtle, `${theme.name}: disabled option text`);
      // The defect itself: text must never match the list it sits on.
      assert.notEqual(options[0].color, options[0].background, `${theme.name}: text invisible on its background`);
    }
  } finally {
    await browser.close();
  }
});
