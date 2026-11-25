import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { bedrockLevelDat, levelDat, regionFile } from './fixtures';
import { parseNbtFile } from '../../src/lib/nbt/nbtfile';
import { decodeChunk, parseChunkRecord, parseRegionHeader, SECTOR } from '../../src/lib/nbt/region';
import { TagType, type CompoundTag } from '../../src/lib/nbt/types';

/** Simulates dropping files onto the app (no file picker needed). */
async function dropFiles(page: Page, files: { name: string; data: Uint8Array }[]): Promise<void> {
  const payload = files.map((f) => ({ name: f.name, data: Array.from(f.data) }));
  await page.evaluate((list) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([new Uint8Array(f.data)], f.name));
    const target = document.querySelector('.app')!;
    target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, payload);
}

const row = (page: Page, text: string) => page.locator('.slot').filter({ hasText: text }).first();

let foreign: string[] = [];
let pageErrors: string[] = [];
test.beforeEach(async ({ page, baseURL }) => {
  foreign = [];
  pageErrors = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(baseURL!) && !u.startsWith('data:') && !u.startsWith('blob:')) foreign.push(u);
  });
  // Uncaught errors (e.g. Svelte's effect_update_depth_exceeded) must fail the test.
  page.on('pageerror', (e) => pageErrors.push(e.message));
});
test.afterEach(() => {
  expect(foreign, 'the app must not contact any other origin').toEqual([]);
  expect(pageErrors, 'the page must not throw uncaught errors').toEqual([]);
});

test('empty state explains what to do', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Drop NBT files or a world folder here' })).toBeVisible();
  await expect(page.getByText('Processed locally · nothing uploaded')).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/01-empty.png' });
});

test('about dialog links to the source code', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('About NBT-Editor').click();
  const source = page.getByRole('link', { name: 'Source' });
  await expect(source).toHaveAttribute('href', 'https://github.com/HazDu/NBT-Editor');
  await expect(source).toHaveAttribute('target', '_blank');
  await page.screenshot({ path: 'test-results/screens/00-about.png' });
});

test('open, edit, undo, search and download with backup', async ({ page }) => {
  const original = await levelDat();
  await page.goto('/');
  await dropFiles(page, [{ name: 'level.dat', data: original }]);
  await expect(page.getByRole('tab', { name: /level\.dat/ })).toBeVisible();

  // Expand Data → Player
  await row(page, 'Data').locator('.chev').click();
  await row(page, 'Player').locator('.chev').click();
  await expect(row(page, 'Health')).toContainText('20.0');

  // Edit Health inline: select row, Enter, type, Enter
  await row(page, 'Health').click();
  await page.keyboard.press('Enter');
  const input = page.locator('.value-edit');
  await input.fill('7.5');
  await input.press('Enter');
  await expect(row(page, 'Health')).toContainText('7.5');
  await expect(page.locator('.tab.active .dot')).toBeVisible();

  // Undo / redo
  await page.locator('.tree').focus();
  await page.keyboard.press('Control+z');
  await expect(row(page, 'Health')).toContainText('20.0');
  await page.keyboard.press('Control+y');
  await expect(row(page, 'Health')).toContainText('7.5');

  // Rename via inspector
  await row(page, 'XpLevel').click();
  const nameField = page.locator('.inspector input.field').first();
  await nameField.fill('XpLevelRenamed');
  await nameField.press('Enter');
  await expect(row(page, 'XpLevelRenamed')).toBeVisible();

  // Search
  await page.keyboard.press('Control+f');
  await page.locator('[data-search-input]').fill('');
  await page.getByPlaceholder('Value, e.g. minecraft:diamond').fill('magma');
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  // "Magma Test World" (LevelName) and minecraft:magma_block: case-insensitive by default
  await expect(page.locator('.results li button')).toHaveCount(2);
  await page.locator('.results li button').filter({ hasText: 'magma_block' }).click();
  await expect(page.locator('.slot .row.selected')).toContainText('minecraft:magma_block');
  await page.screenshot({ path: 'test-results/screens/02-edit-search.png' });

  // Changes panel lists commits
  await page.getByRole('button', { name: 'Changes' }).first().click();
  await expect(page.locator('.entry')).toHaveCount(2);

  // Download with backup → two files; there is a single Download action (no in-place save)
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await page.keyboard.press('Control+S');
  await expect(page.getByRole('heading', { name: 'Download' })).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/03-export.png' });
  const downloads: { name: string; path: string }[] = [];
  page.on('download', async (d) => downloads.push({ name: d.suggestedFilename(), path: await d.path() }));
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect.poll(() => downloads.length).toBe(2);
  const backup = downloads.find((d) => d.name === 'level.dat.backup')!;
  const edited = downloads.find((d) => d.name === 'level.dat')!;
  expect(new Uint8Array(readFileSync(backup.path))).toEqual(original);
  const parsed = await parseNbtFile(new Uint8Array(readFileSync(edited.path)));
  expect(parsed.format.compression).toBe('gzip');
  const player = ((parsed.root.tag as CompoundTag).value.get('Data') as CompoundTag).value.get('Player') as CompoundTag;
  expect(player.value.get('Health')).toEqual({ type: TagType.Float, value: 7.5 });
  expect(player.value.has('XpLevelRenamed')).toBe(true);
  await expect(page.locator('.tab.active .dot')).toHaveCount(0);
});

test('copy and paste between tabs', async ({ page }) => {
  await page.goto('/');
  await dropFiles(page, [
    { name: 'level.dat', data: await levelDat() },
    { name: 'bedrock_level.dat', data: await bedrockLevelDat() },
  ]);
  await expect(page.getByRole('tab')).toHaveCount(2);

  // Copy the Inventory list from level.dat
  await page.getByRole('tab', { name: /^level\.dat/ }).click();
  await row(page, 'Data').locator('.chev').click();
  await row(page, 'Player').locator('.chev').click();
  await row(page, 'Inventory').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Copy/ }).first().click();

  // Paste into the Bedrock file root
  await page.getByRole('tab', { name: /bedrock_level\.dat/ }).click();
  await expect(row(page, 'LevelName')).toContainText('Bedrock World');
  await row(page, 'bedrock_level.dat').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Paste/ }).first().click();
  await expect(row(page, 'Inventory')).toContainText('3 entries');
  await expect(page.locator('.status')).toContainText('Bedrock · LE');
  await page.screenshot({ path: 'test-results/screens/04-two-tabs.png' });
});

test('region files: lazy chunks incl. LZ4, edit, export copies untouched chunks', async ({ page }) => {
  const original = await regionFile();
  await page.goto('/');
  await dropFiles(page, [{ name: 'r.0.0.mca', data: original }]);
  await expect(page.locator('.slot').filter({ hasText: 'Chunk [' })).toHaveCount(3);

  // The LZ4 chunk (1,0)
  await row(page, 'Chunk [1, 0]').locator('.chev').click();
  await expect(row(page, 'Chunk [1, 0]')).toContainText('LZ4');
  await expect(row(page, 'Status')).toContainText('minecraft:full-1');
  await row(page, 'Status').click();
  await page.keyboard.press('Enter');
  await page.locator('.value-edit').fill('minecraft:edited');
  await page.locator('.value-edit').press('Enter');
  await page.screenshot({ path: 'test-results/screens/05-region.png' });

  await page.keyboard.press('Control+S');
  const downloads: { name: string; path: string }[] = [];
  page.on('download', async (d) => downloads.push({ name: d.suggestedFilename(), path: await d.path() }));
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect.poll(() => downloads.length).toBe(2);

  const out = new Uint8Array(readFileSync(downloads.find((d) => d.name === 'r.0.0.mca')!.path));
  const before = parseRegionHeader(original.subarray(0, 2 * SECTOR), original.length);
  const after = parseRegionHeader(out.subarray(0, 2 * SECTOR), out.length);
  expect(after.map((x) => x.index)).toEqual([0, 1, 2]);
  const sectors = (buf: Uint8Array, sl: (typeof after)[number]) => buf.subarray(sl.sectorOffset * SECTOR, (sl.sectorOffset + sl.sectorCount) * SECTOR);
  // untouched chunks are byte-identical
  expect(sectors(out, after[0])).toEqual(sectors(original, before[0]));
  expect(sectors(out, after[2])).toEqual(sectors(original, before[2]));
  // the edited chunk is still LZ4 and contains the new value
  const rec = parseChunkRecord(sectors(out, after[1]));
  expect(rec.compressionId).toBe(4);
  const root = await decodeChunk(rec.compressionId, rec.payload);
  expect((root.tag as CompoundTag).value.get('Status')).toEqual({ type: TagType.String, value: 'minecraft:edited' });
  // backup is the original
  expect(new Uint8Array(readFileSync(downloads.find((d) => d.name === 'r.0.0.mca.backup')!.path))).toEqual(original);
});

test('search scans unloaded region chunks in a worker', async ({ page }) => {
  await page.goto('/');
  await dropFiles(page, [{ name: 'r.0.0.mca', data: await regionFile() }]);
  await page.keyboard.press('Control+f');
  await page.locator('[data-search-input]').fill('Status');
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await expect(page.locator('.results li button')).toHaveCount(3);
  await page.locator('.results li button').nth(2).click();
  await expect(page.locator('.slot .row.selected')).toContainText('Status');
});

test('find this value: an int-array UUID is found everywhere it appears', async ({ page }) => {
  await page.goto('/');
  await dropFiles(page, [{ name: 'level.dat', data: await levelDat() }]);
  await row(page, 'Data').locator('.chev').click();
  await row(page, 'Player').locator('.chev').click();
  await row(page, 'UUID').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Find this value/ }).click();
  await expect(page.locator('.results li button')).toHaveCount(2);
  await expect(page.getByPlaceholder('Value, e.g. minecraft:diamond')).toHaveValue('[I;-2028501662,896618238,-1451723461,-1580375395]');
  // typing the array by hand works too, with spaces
  await page.getByPlaceholder('Value, e.g. minecraft:diamond').fill('[I; -2028501662, 896618238, -1451723461, -1580375395]');
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await expect(page.locator('.results li button')).toHaveCount(2);
  await page.locator('.results li button').nth(1).click();
  await expect(page.locator('.slot .row.selected')).toContainText('UUID');
  await expect(page.locator('.inspector .uuid')).toContainText(/^.*[0-9a-f]{8}-[0-9a-f]{4}-/);
  await page.screenshot({ path: 'test-results/screens/06-find-uuid.png' });
});
