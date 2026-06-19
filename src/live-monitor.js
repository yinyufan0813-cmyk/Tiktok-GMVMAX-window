import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { extractLiveDashboardMetrics } from "./extract-live-dashboard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PREFIX = "LIVE-MONITOR";

const DEFAULT_CONFIG = {
  mode: "attach",
  cdpEndpoint: "http://127.0.0.1:9222",
  intervalMinutes: 5,
  headless: false,
  profileDir: "./chrome-profile-win",
  outputDir: "./logs",
  locale: "zh-CN",
  timezoneId: "Asia/Kuala_Lumpur",
  liveAnalytics: {
    overviewUrl: "https://seller-my.tiktok.com/compass/data-overview?shop_region=MY",
    campaignUrl: "https://seller-my.tiktok.com/workbench/campaign?campaign_id=7615079383917037328&lang=en&btm_ppre=a0.b0.c0.d0&btm_pre=a1518.b0434.c0.d0&btm_show_id=3e8c3750-57cf-49f6-a309-fd606bbf6fa9",
    preferCampaignLiveList: true,
    campaignOpenDashboards: false,
    campaignLiveHandles: ["@youmilier.klasik", "@youmilier.fashion", "@youmilier"],
    maxRooms: 12,
    liveStreamsText: "LIVE streams",
    liveRoomTexts: [],
    discoverEveryRun: true,
    selectors: {
      liveStreamsTrigger: "",
      liveRoomItems: "",
      metricHover: "",
      roomName: "",
      currentViewers: "",
      tapThroughRateViaLivePreview: "",
      tapThroughRate: "",
      liveCtr: "",
      orderRateSkuOrders: "",
      adsCost: "",
      gmvMaxRoi: ""
    }
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const args = new Set(process.argv.slice(2));
  const once = args.has("--once");
  const listTabs = args.has("--list-tabs");
  const config = await loadConfig();
  const outputDir = resolveProjectPath(config.outputDir);
  const intervalMs = Math.max(1, Number(config.liveAnalytics.intervalMinutes || config.intervalMinutes || 5)) * 60 * 1000;

  await fs.mkdir(outputDir, { recursive: true });
  const lock = await acquireProcessLock(path.join(outputDir, "live-monitor.lock"));

  let session = null;
  try {
    session = await getBrowserSession(config);
    if (listTabs) {
      await printOpenTabs(session.context);
      await session.close();
      return;
    }

    let overviewPage = await findOrOpenOverviewPage(session.context, config);
    const livePages = new Map();
    console.log(`[${PREFIX}] Attached overview: ${await safeTitle(overviewPage)} | ${overviewPage.url()}`);
    console.log(`[${PREFIX}] Started. Refresh interval: ${intervalMs / 60_000} minute(s).`);

    do {
      overviewPage = await collectOnce({ context: session.context, overviewPage, livePages, config, outputDir });
      if (once) break;
      await wait(intervalMs);
    } while (true);
  } finally {
    await session?.close?.();
    await lock.release();
  }
  if (once || listTabs) process.exit(process.exitCode || 0);
}

async function acquireProcessLock(lockPath) {
  const payload = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify(payload));
    return {
      release: async () => {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      }
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const existing = await fs.readFile(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => ({}));
  if (existing.pid && isPidRunning(existing.pid)) {
    throw new Error(`[${PREFIX}] Another LIVE monitor is already running (PID ${existing.pid}). Stop it before starting a new one.`);
  }
  await fs.unlink(lockPath).catch(() => {});
  return acquireProcessLock(lockPath);
}

function isPidRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function loadConfig() {
  const configPath = process.env.GMVMAX_CONFIG || path.join(PROJECT_ROOT, "config.json");
  let override = {};
  try {
    override = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return mergeConfig(DEFAULT_CONFIG, override);
}

function mergeConfig(base, override) {
  const liveOverride = override.liveAnalytics || {};
  return {
    ...base,
    ...override,
    outputDir: process.env.GMVMAX_OUTPUT_DIR || override.outputDir || base.outputDir,
    liveAnalytics: {
      ...base.liveAnalytics,
      ...liveOverride,
      overviewUrl: process.env.LIVE_ANALYTICS_URL || liveOverride.overviewUrl || base.liveAnalytics.overviewUrl,
      selectors: {
        ...base.liveAnalytics.selectors,
        ...(liveOverride.selectors || {})
      }
    }
  };
}

function resolveProjectPath(value) {
  if (!value) return PROJECT_ROOT;
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

async function getBrowserSession(config) {
  if (config.mode === "launch") {
    await fs.mkdir(resolveProjectPath(config.profileDir), { recursive: true });
    const context = await chromium.launchPersistentContext(resolveProjectPath(config.profileDir), {
      channel: "chrome",
      headless: Boolean(config.headless),
      locale: config.locale,
      timezoneId: config.timezoneId,
      viewport: { width: 1920, height: 1080 },
      args: ["--disable-blink-features=AutomationControlled"]
    });
    return { context, close: () => context.close() };
  }

  const browser = await chromium.connectOverCDP(config.cdpEndpoint);
  const context = browser.contexts()[0] || (await browser.newContext());
  return { context, close: async () => {} };
}

async function printOpenTabs(context) {
  const pages = context.pages();
  if (pages.length === 0) {
    console.log(`[${PREFIX}] No open pages found.`);
    return;
  }
  for (const [index, page] of pages.entries()) {
    console.log(`[${index + 1}] ${await safeTitle(page)} | ${page.url()}`);
  }
}

async function findOrOpenOverviewPage(context, config) {
  const overviewUrl = config.liveAnalytics.overviewUrl;
  const scored = [];
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const url = page.url();
    if (!url || url.startsWith("chrome://") || url.startsWith("devtools://")) continue;
    const score = scoreOverviewPage(url, overviewUrl);
    if (score > 0) scored.push({ page, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]) return scored[0].page;

  const page = await context.newPage();
  await page.goto(overviewUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  return page;
}

function scoreOverviewPage(currentUrl, overviewUrl) {
  const current = safelyParseUrl(currentUrl);
  const overview = safelyParseUrl(overviewUrl);
  if (!current || !overview) return 0;
  let score = 0;
  if (current.host !== overview.host) return 0;
  if (!current.pathname.includes("/compass/data-overview")) return 0;
  score += 8;
  if (current.pathname === overview.pathname) score += 8;
  if (currentUrl === overviewUrl) score += 10;
  return score;
}

function safelyParseUrl(value) {
  try { return value ? new URL(value) : null; } catch { return null; }
}

async function collectOnce({ context, overviewPage, livePages, config, outputDir }) {
  const timestamp = new Date().toISOString();
  console.log(`[${PREFIX}] ${timestamp} discovering LIVE rooms...`);
  overviewPage = await ensureOverviewPage(context, overviewPage, config);
  syncExistingLivePages(context, livePages);
  await auditLiveDashboardPages(context, livePages, "before discovery");
  await dedupeLivePages(context, overviewPage, livePages);

  let discoveredRoomCount = null;
  if (config.liveAnalytics.discoverEveryRun !== false) {
    discoveredRoomCount = await syncLivePages(context, overviewPage, livePages, config);
    syncExistingLivePages(context, livePages);
  } else {
    syncExistingLivePages(context, livePages);
  }

  if (config.liveAnalytics.discoverEveryRun !== false && discoveredRoomCount == null) {
    console.warn(`[${PREFIX}] Skipped this LIVE sample because the overview LIVE streams list was not rediscovered.`);
    return overviewPage;
  }

  if (livePages.size === 0) {
    console.warn(`[${PREFIX}] No LIVE dashboard pages found. Hover/click the LIVE streams list once or add selectors in config.json.`);
    return overviewPage;
  }

  await auditLiveDashboardPages(context, livePages, "after discovery");
  await dedupeLivePages(context, overviewPage, livePages);
  await auditLiveDashboardPages(context, livePages, "after dedupe");

  const records = [];
  const seenRoomIds = new Set();
  for (const [key, entry] of livePages.entries()) {
    if (entry.page.isClosed()) {
      const replacement = findLivePageReplacement(context, entry);
      if (replacement) {
        entry.page = replacement;
        entry.url = replacement.url();
      } else {
        livePages.delete(key);
        continue;
      }
    }
    const roomId = liveRoomIdFromUrl(entry.page.url() || entry.url || "");
    if (roomId && seenRoomIds.has(roomId)) {
      await entry.page?.close?.().catch(() => {});
      livePages.delete(key);
      continue;
    }
    if (roomId) seenRoomIds.add(roomId);
    const record = await collectLivePage(entry.page, timestamp, config, outputDir, entry.label).catch(async (error) => {
      if (isClosedTargetError(error)) {
        const replacement = findLivePageReplacement(context, entry);
        if (replacement && replacement !== entry.page) {
          entry.page = replacement;
          entry.url = replacement.url();
          return collectLivePage(entry.page, timestamp, config, outputDir, entry.label).catch((retryError) => {
            console.warn(`[${PREFIX}] Failed to read ${key} after reattaching: ${retryError.message}`);
            return null;
          });
        }
      }
      console.warn(`[${PREFIX}] Failed to read ${key}: ${error.message}`);
      return null;
    });
    if (record) records.push(record);
  }

  await wait(1500);
  await closeUntrackedLiveDashboardPages(context, overviewPage, livePages);
  await auditLiveDashboardPages(context, livePages, "after collection cleanup");

  const uniqueRecords = dedupeLiveRecords(records);
  if (uniqueRecords.length === 0) return overviewPage;
  if (Number.isFinite(discoveredRoomCount) && uniqueRecords.length < discoveredRoomCount) {
    console.warn(`[${PREFIX}] Skipped partial LIVE sample: collected ${uniqueRecords.length}/${discoveredRoomCount} discovered room(s).`);
    return overviewPage;
  }
  await appendJsonl(path.join(outputDir, "live-room-records.jsonl"), { timestamp, records: uniqueRecords });
  await appendLiveCsv(path.join(outputDir, "live-room-records.csv"), uniqueRecords);
  console.log(`[${PREFIX}] Saved ${uniqueRecords.length} LIVE room record(s).`);
  await closeUntrackedLiveDashboardPages(context, overviewPage, livePages);
  return overviewPage;
}

async function ensureOverviewPage(context, overviewPage, config) {
  if (overviewPage && !overviewPage.isClosed()) return overviewPage;
  console.warn(`[${PREFIX}] Overview page was closed. Reopening ${config.liveAnalytics.overviewUrl}`);
  return findOrOpenOverviewPage(context, config);
}

function syncExistingLivePages(context, livePages) {
  for (const page of context.pages()) {
    const url = page.url();
    if (!isLiveDashboardUrl(url)) continue;
    const key = livePageKey(url);
    const existing = livePages.get(key);
    if (existing && existing.page !== page) continue;
    livePages.set(key, { page, label: existing?.label || liveLabelFromUrl(url), url });
  }
}

function isLiveDashboardUrl(url) {
  const parsed = safelyParseUrl(url);
  return parsed?.host === "seller-my.tiktok.com" && /^\/workbench\/live(?:\/overview)?$/.test(parsed.pathname);
}

function liveRoomIdFromUrl(url) {
  return safelyParseUrl(url)?.searchParams.get("room_id") || "";
}

function livePageKey(url) {
  return liveRoomIdFromUrl(url) || normalizeUrl(url);
}

function findLivePageReplacement(context, entry) {
  const roomId = liveRoomIdFromUrl(entry.url || entry.page?.url?.() || "");
  const pages = context.pages().filter((page) => !page.isClosed() && isLiveDashboardUrl(page.url()));
  return pages.find((page) => roomId && liveRoomIdFromUrl(page.url()) === roomId) || pages.find((page) => normalizeUrl(page.url()) === normalizeUrl(entry.url || "")) || null;
}

async function dedupeLivePages(context, keepPage, livePages) {
  const byRoomId = new Map();
  for (const [key, entry] of Array.from(livePages.entries())) {
    if (!entry.page || entry.page.isClosed()) {
      livePages.delete(key);
      continue;
    }
    const url = entry.page.url() || entry.url || "";
    if (!isLiveDashboardUrl(url)) {
      livePages.delete(key);
      continue;
    }
    const roomId = liveRoomIdFromUrl(url);
    if (!roomId) continue;
    const existing = byRoomId.get(roomId);
    if (!existing) {
      byRoomId.set(roomId, { key, entry });
      continue;
    }
    const existingHasHandle = /^@/.test(existing.entry.label || "");
    const currentHasHandle = /^@/.test(entry.label || "");
    const keepCurrent = currentHasHandle && !existingHasHandle;
    const remove = keepCurrent ? existing : { key, entry };
    if (keepCurrent) byRoomId.set(roomId, { key, entry });
    await remove.entry.page?.close?.().catch(() => {});
    livePages.delete(remove.key);
  }

  for (const [roomId, { key, entry }] of byRoomId.entries()) {
    if (key === roomId) continue;
    livePages.delete(key);
    livePages.set(roomId, entry);
  }
  await closeUntrackedLiveDashboardPages(context, keepPage, livePages);
}

async function auditLiveDashboardPages(context, livePages, stage) {
  const pages = context.pages().filter((page) => !page.isClosed() && isLiveDashboardUrl(page.url()));
  const byRoomId = new Map();
  for (const page of pages) {
    const roomId = liveRoomIdFromUrl(page.url()) || normalizeUrl(page.url());
    if (!byRoomId.has(roomId)) byRoomId.set(roomId, []);
    byRoomId.get(roomId).push(page);
  }

  const duplicateGroups = Array.from(byRoomId.entries()).filter(([, group]) => group.length > 1);
  if (duplicateGroups.length === 0) {
    console.log(`[${PREFIX}] LIVE page audit ${stage}: ${pages.length} dashboard page(s), no duplicate room_id.`);
    return;
  }

  for (const [roomId, group] of duplicateGroups) {
    console.warn(`[${PREFIX}] LIVE page audit ${stage}: duplicate room_id ${roomId} has ${group.length} dashboard pages. Closing extras.`);
    const tracked = group.find((page) => Array.from(livePages.values()).some((entry) => entry.page === page));
    const keep = tracked || group[0];
    for (const page of group) {
      if (page === keep) continue;
      await page.close().catch(() => {});
    }
  }
}

function dedupeLiveRecords(records) {
  const byRoom = new Map();
  for (const record of records) {
    const roomId = liveRoomIdFromUrl(record.url || "");
    const key = roomId || record.url || record.room;
    const existing = byRoom.get(key);
    if (!existing) {
      byRoom.set(key, record);
      continue;
    }
    const existingHasHandle = /^@/.test(existing.room || "");
    const currentHasHandle = /^@/.test(record.room || "");
    if (currentHasHandle && !existingHasHandle) {
      byRoom.set(key, record);
    }
  }
  return Array.from(byRoom.values());
}

function isClosedTargetError(error) {
  return /Target page, context or browser has been closed|Target closed|Page closed/i.test(error?.message || "");
}

async function syncLivePages(context, overviewPage, livePages, config) {
  syncExistingLivePages(context, livePages);
  if (
    config.liveAnalytics.campaignUrl &&
    config.liveAnalytics.preferCampaignLiveList !== false &&
    config.liveAnalytics.campaignOpenDashboards === true
  ) {
    const campaignCount = await syncLivePagesFromCampaign(context, livePages, config).catch((error) => {
      console.warn(`[${PREFIX}] Campaign LIVE discovery failed: ${error.message}`);
      return null;
    });
    if (Number.isFinite(campaignCount)) return campaignCount;
  }

  await overviewPage.goto(config.liveAnalytics.overviewUrl, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
  await overviewPage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await acceptVisibleDialogs(overviewPage);
  const menuOpened = await openLiveStreamsMenu(overviewPage, config).catch((error) => {
    console.warn(`[${PREFIX}] Could not open LIVE streams menu: ${error.message}`);
    return false;
  });
  if (!menuOpened) {
    syncExistingLivePages(context, livePages);
    if (livePages.size === 0) {
      console.warn(`[${PREFIX}] LIVE streams trigger was not found. No active LIVE rooms were discovered on the overview page.`);
    }
    return null;
  }
  const candidates = await collectLiveRoomCandidates(overviewPage, config);
  const filtered = filterCandidates(candidates, config).slice(0, config.liveAnalytics.maxRooms || 12);

  if (filtered.length === 0) {
    syncExistingLivePages(context, livePages);
    console.warn(`[${PREFIX}] LIVE streams menu opened, but no room candidates were found. Reusing ${livePages.size} existing LIVE dashboard page(s).`);
    return livePages.size || null;
  }

  console.log(`[${PREFIX}] Found ${filtered.length} LIVE room candidate(s): ${filtered.map((candidate) => candidate.handle || candidate.key).join(", ")}`);
  const activeKeys = new Set(filtered.map((candidate, index) => candidate.key || candidate.href || `room-${index + 1}`));
  const activeLabels = new Set(filtered.map((candidate) => candidate.handle).filter(Boolean));
  for (const [key, entry] of livePages.entries()) {
    if (!entry.page || entry.page.isClosed()) {
      livePages.delete(key);
      continue;
    }
    if (!isLiveDashboardUrl(entry.page.url())) livePages.delete(key);
  }

  const activePages = new Set();
  for (const [index, candidate] of filtered.entries()) {
    const key = candidate.key || candidate.href || `room-${index + 1}`;
    const existing =
      livePages.get(key) ||
      Array.from(livePages.values()).find((entry) => entry.label && entry.label === candidate.handle) ||
      await findExistingLiveEntryForCandidate(context, livePages, candidate, key);
    if (existing && !existing.page.isClosed() && isLiveDashboardUrl(existing.page.url())) {
      existing.label = candidate.handle || existing.label;
      existing.url = existing.page.url();
      await markLivePageHandle(existing.page, existing.label);
      activePages.add(existing.page);
      console.log(`[${PREFIX}] Reusing LIVE room ${candidate.handle || key}: ${existing.page.url()}`);
      continue;
    }

    const page = await openLiveDashboardFromCandidate(context, config, candidate, index);
    if (page) {
      const registered = await registerLivePage(livePages, page, candidate, key);
      if (registered?.page) activePages.add(registered.page);
      const action = registered?.page === page ? "Opened" : "Reusing";
      console.log(`[${PREFIX}] ${action} LIVE room ${candidate.handle || key}: ${registered?.page?.url?.() || page.url()}`);
    } else {
      console.warn(`[${PREFIX}] Could not open LIVE room ${candidate.handle || key}.`);
    }
  }
  await closeInactiveUnmatchedLivePages(context, overviewPage, livePages, activePages, activeLabels);
  await wait(1500);
  syncExistingLivePages(context, livePages);
  return filtered.length;
}

async function closeInactiveUnmatchedLivePages(context, overviewPage, livePages, activePages, activeLabels) {
  for (const [key, entry] of Array.from(livePages.entries())) {
    const page = entry.page;
    if (!page || page.isClosed()) {
      livePages.delete(key);
      continue;
    }
    if (overviewPage && page === overviewPage) continue;
    if (!isLiveDashboardUrl(page.url())) {
      livePages.delete(key);
      continue;
    }
    if (activePages.has(page)) continue;
    if (entry.label && activeLabels.has(entry.label) && await livePageStillHasActivity(page)) continue;
    if (await livePageStillHasActivity(page)) continue;
    await page.close().catch(() => {});
    livePages.delete(key);
  }
}

async function syncLivePagesFromCampaign(context, livePages, config) {
  const page = await findOrOpenCampaignPage(context, config);
  await page.goto(config.liveAnalytics.campaignUrl, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await acceptVisibleDialogs(page);

  const opened = await openCampaignLivePerformance(page);
  if (!opened) return null;

  const candidates = await collectCampaignLiveCandidates(page, config);
  const filtered = filterCandidates(candidates, config).slice(0, config.liveAnalytics.maxRooms || 12);
  if (filtered.length === 0) return null;

  console.log(`[${PREFIX}] Found ${filtered.length} campaign LIVE candidate(s): ${filtered.map((candidate) => candidate.handle || candidate.key).join(", ")}`);
  const activeKeys = new Set(filtered.map((candidate) => candidate.key || candidate.handle).filter(Boolean));
  const activeLabels = new Set(filtered.map((candidate) => candidate.handle).filter(Boolean));
  for (const [key, entry] of livePages.entries()) {
    if (activeKeys.has(key)) continue;
    if (entry.label && activeLabels.has(entry.label)) continue;
    await entry.page?.close?.().catch(() => {});
    livePages.delete(key);
  }

  let openedCount = 0;
  const campaignOpenedPages = new Set();
  for (const [index, candidate] of filtered.entries()) {
    const key = candidate.key || candidate.handle || `campaign-room-${index + 1}`;
    const existing =
      livePages.get(key) ||
      Array.from(livePages.values()).find((entry) => entry.label && entry.label === candidate.handle) ||
      await findExistingLiveEntryForCandidate(context, livePages, candidate, key);
    if (existing && !existing.page.isClosed() && isLiveDashboardUrl(existing.page.url())) {
      existing.label = candidate.handle || existing.label;
      existing.url = existing.page.url();
      console.log(`[${PREFIX}] Reusing campaign LIVE room ${candidate.handle || key}: ${existing.page.url()}`);
      continue;
    }

    await page.bringToFront().catch(() => {});
    await openCampaignLivePerformance(page);
    const freshCandidates = await collectCampaignLiveCandidates(page, config);
    const fresh = freshCandidates.find((item) =>
      (candidate.handle && item.handle === candidate.handle) ||
      (candidate.key && item.key === candidate.key)
    );
    if (!fresh) {
      console.warn(`[${PREFIX}] Campaign LIVE room ${candidate.handle || key} disappeared before opening.`);
      continue;
    }

    const livePage = await openCampaignLiveDashboard(context, page, fresh);
    if (!livePage) {
      console.warn(`[${PREFIX}] Could not open campaign LIVE room ${candidate.handle || key}.`);
      continue;
    }
    await registerLivePage(livePages, livePage, candidate, key);
    campaignOpenedPages.add(livePage);
    openedCount += 1;
    console.log(`[${PREFIX}] Opened campaign LIVE room ${candidate.handle || key}: ${livePage.url()}`);
  }

  if (openedCount < filtered.length) return null;
  await wait(1500);
  syncExistingLivePages(context, livePages);
  return filtered.length;
}

async function findOrOpenCampaignPage(context, config) {
  const target = safelyParseUrl(config.liveAnalytics.campaignUrl);
  const existing = context.pages().find((page) => {
    if (page.isClosed()) return false;
    const current = safelyParseUrl(page.url());
    return current?.host === target?.host &&
      current?.pathname === target?.pathname &&
      current?.searchParams.get("campaign_id") === target?.searchParams.get("campaign_id");
  });
  if (existing) return existing;
  return context.newPage();
}

async function openCampaignLivePerformance(page) {
  const alreadyOpen = await page.evaluate(() => /LIVE performance/i.test(document.body?.innerText || "")).catch(() => false);
  if (alreadyOpen) return true;

  const point = await page.evaluate(() => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const visibleRect = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      if (rect.width <= 2 || rect.height <= 2 || style.display === "none" || style.visibility === "hidden") return null;
      return rect;
    };

    const liveNode = Array.from(document.querySelectorAll("div,section"))
      .map((node) => ({ node, text: textOf(node), rect: visibleRect(node) }))
      .filter((item) => item.rect && /ongoing LIVE streams/i.test(item.text))
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
    if (!liveNode) return null;

    let card = liveNode.node;
    for (let i = 0; i < 8 && card?.parentElement; i += 1) {
      const rect = card.getBoundingClientRect();
      const text = textOf(card);
      if (text.includes("LIVE") && /ongoing LIVE streams/i.test(text) && rect.width >= 260 && rect.width <= 620 && rect.height >= 120 && rect.height <= 520) break;
      card = card.parentElement;
    }

    const buttons = Array.from(card.querySelectorAll("button, [role='button'], [tabindex]"))
      .map((node) => ({ node, rect: visibleRect(node), text: textOf(node) }))
      .filter((item) => item.rect)
      .sort((a, b) => b.rect.left - a.rect.left || a.rect.top - b.rect.top);
    const button = buttons.find((item) => item.rect.left > card.getBoundingClientRect().left + card.getBoundingClientRect().width * 0.65) || buttons[0];
    if (!button) return null;
    return { x: button.rect.x + button.rect.width / 2, y: button.rect.y + button.rect.height / 2 };
  }).catch(() => null);

  if (!point) return false;
  await page.mouse.click(point.x, point.y).catch(() => {});
  await page.waitForTimeout(1800);
  return page.evaluate(() => /LIVE performance/i.test(document.body?.innerText || "")).catch(() => false);
}

async function collectCampaignLiveCandidates(page, config) {
  const wantedHandles = config.liveAnalytics.campaignLiveHandles || [];
  return page.evaluate((wantedHandles) => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 2 &&
        rect.height > 2 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        style.visibility !== "hidden" &&
        style.display !== "none";
    };
    const handles = wantedHandles.length ? wantedHandles : (document.body?.innerText.match(/@[A-Za-z0-9._-]+/g) || []);
    const uniqueHandles = Array.from(new Set(handles));
    const modal = Array.from(document.querySelectorAll("div"))
      .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
      .filter((item) =>
        item.text.includes("LIVE performance") &&
        item.text.includes("Action") &&
        item.rect.width > 1000 &&
        item.rect.height > 500
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0]?.node || document.body;

    const candidates = [];
    const seen = new Set();
    for (const handle of uniqueHandles) {
      const labelNode = Array.from(modal.querySelectorAll("div,span,p"))
        .filter(visible)
        .map((node) => ({ node, text: textOf(node) }))
        .filter((item) => item.text.includes(handle) && item.text.length <= 260)
        .sort((a, b) => a.text.length - b.text.length)[0]?.node;
      if (!labelNode || seen.has(handle)) continue;

      let row = labelNode.closest("tr");
      let parent = labelNode;
      for (let i = 0; !row && i < 10 && parent?.parentElement; i += 1) {
        parent = parent.parentElement;
        const rect = parent.getBoundingClientRect();
        const text = textOf(parent);
        if (text.includes(handle) && /Ongoing/i.test(text) && rect.width > 900 && rect.height >= 40 && rect.height <= 140) row = parent;
      }
      if (!row) {
        row = labelNode;
      }
      for (let i = 0; i < 10 && row?.parentElement; i += 1) {
        const rect = row.getBoundingClientRect();
        const text = textOf(row);
        if (
          text.includes(handle) &&
          /Ongoing/i.test(text) &&
          rect.width > 900 &&
          rect.height >= 40 &&
          rect.height <= 140
        ) {
          break;
        }
        row = row.parentElement;
      }
      if (!row) continue;

      const rowRect = row.getBoundingClientRect();
      const buttons = Array.from(row.querySelectorAll("button, [role='button'], [tabindex]"))
        .filter(visible)
        .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
        .filter((item) => item.rect.left > rowRect.left + rowRect.width * 0.72)
        .sort((a, b) => b.rect.left - a.rect.left);
      const button = buttons.find((item) => /LIVE dash/i.test(item.text)) || buttons[0];
      if (!button) continue;

      const marker = `gmvmax-campaign-live-${candidates.length + 1}`;
      button.node.setAttribute("data-gmvmax-campaign-live-candidate", marker);
      seen.add(handle);
      candidates.push({
        marker,
        handle,
        key: handle,
        text: textOf(row),
        href: "",
        source: "campaign",
        rect: { x: button.rect.x, y: button.rect.y, width: button.rect.width, height: button.rect.height }
      });
    }
    return candidates;
  }, wantedHandles);
}

async function openCampaignLiveDashboard(context, campaignPage, candidate) {
  const locator = campaignPage.locator(`[data-gmvmax-campaign-live-candidate="${candidate.marker}"]`).first();
  const exists = await locator.count().then((count) => count > 0).catch(() => false);
  if (exists) {
    await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" })).catch(() => {});
  }

  const beforeUrl = campaignPage.url();
  const newPagePromise = context.waitForEvent("page", { timeout: 10_000 }).catch(() => null);
  if (exists) {
    await locator.click({ timeout: 10_000, force: true }).catch(async () => {
      await campaignPage.mouse.click(candidate.rect.x + candidate.rect.width / 2, candidate.rect.y + candidate.rect.height / 2).catch(() => {});
    });
  } else {
    await campaignPage.mouse.click(candidate.rect.x + candidate.rect.width / 2, candidate.rect.y + candidate.rect.height / 2).catch(() => {});
  }

  const opened = await newPagePromise;
  if (opened) {
    await opened.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
    await opened.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    if (isLiveDashboardUrl(opened.url())) return opened;
    await opened.close().catch(() => {});
    return null;
  }

  await campaignPage.waitForURL((url) => url.toString() !== beforeUrl, { timeout: 30_000 }).catch(() => {});
  if (isLiveDashboardUrl(campaignPage.url())) return campaignPage;
  return null;
}

async function registerLivePage(livePages, page, candidate, fallbackKey) {
  const url = page.url();
  const roomId = liveRoomIdFromUrl(url);
  const label = candidate.handle || candidate.text || liveLabelFromUrl(url);
  const duplicate = Array.from(livePages.entries()).find(([, entry]) => {
    if (entry.page === page) return false;
    const entryRoomId = liveRoomIdFromUrl(entry.page?.url?.() || entry.url || "");
    if (roomId && entryRoomId && roomId === entryRoomId) return true;
    return label && entry.label === label;
  });

  if (duplicate) {
    const [, existing] = duplicate;
    existing.label = label || existing.label;
    existing.url = existing.page?.url?.() || existing.url;
    await markLivePageHandle(existing.page, existing.label);
    await page.close().catch(() => {});
    return existing;
  }

  for (const [key, entry] of Array.from(livePages.entries())) {
    if (entry.page === page || (label && entry.label === label) || (roomId && liveRoomIdFromUrl(entry.page?.url?.() || entry.url || "") === roomId)) {
      livePages.delete(key);
    }
  }
  livePages.set(roomId || fallbackKey || label || normalizeUrl(url), { page, label, url });
  await markLivePageHandle(page, label);
  return livePages.get(roomId || fallbackKey || label || normalizeUrl(url));
}

async function findExistingLiveEntryForCandidate(context, livePages, candidate, fallbackKey) {
  const handle = candidate.handle || "";
  const bareHandle = handle.replace(/^@/, "");
  if (!handle && !bareHandle) return null;

  for (const page of context.pages()) {
    if (page.isClosed() || !isLiveDashboardUrl(page.url())) continue;
    const identity = await livePageIdentity(page).catch(() => ({ title: "", body: "" }));
    if (!liveIdentityMatchesHandle(identity, handle || bareHandle)) continue;
    return registerLivePage(livePages, page, candidate, fallbackKey);
  }
  return null;
}

function liveIdentityMatchesHandle(identity, handle) {
  if (!identity || !handle) return false;
  const normalizedHandle = handle.replace(/^@/, "");
  const escaped = escapeRegex(normalizedHandle);
  const title = identity.title || "";
  const body = identity.body || "";
  const storedHandle = String(identity.storedHandle || "").replace(/^@/, "");
  if (storedHandle && storedHandle.toLowerCase() === normalizedHandle.toLowerCase()) return true;
  const titlePattern = new RegExp(`(^|[^A-Za-z0-9._-])${escaped}([^A-Za-z0-9._-]|$)`, "i");
  const bodyAtPattern = new RegExp(`(^|[^A-Za-z0-9._-])@${escaped}([^A-Za-z0-9._-]|$)`, "i");
  return titlePattern.test(title) || bodyAtPattern.test(body);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function livePageIdentity(page) {
  const title = await safeTitle(page);
  const { body, storedHandle } = await page.evaluate(() => {
    const text = document.body?.innerText || document.body?.textContent || "";
    const nameMatch = String(window.name || "").match(/gmvmax-live-monitor:([^|]+)/);
    const attr = document.documentElement?.getAttribute("data-gmvmax-live-handle") || "";
    return {
      body: text.slice(0, 5000),
      storedHandle: attr || (nameMatch?.[1] ? decodeURIComponent(nameMatch[1]) : "")
    };
  }).catch(() => ({ body: "", storedHandle: "" }));
  return { title, body, storedHandle };
}

async function markLivePageHandle(page, label) {
  if (!label || !/^@/.test(label) || page.isClosed()) return;
  await page.evaluate((label) => {
    document.documentElement?.setAttribute("data-gmvmax-live-handle", label);
    const marker = `gmvmax-live-monitor:${encodeURIComponent(label)}`;
    window.name = String(window.name || "").includes("gmvmax-live-monitor:")
      ? String(window.name || "").replace(/gmvmax-live-monitor:[^|]+/, marker)
      : [String(window.name || ""), marker].filter(Boolean).join("|");
  }, label).catch(() => {});
}

async function livePageStillHasActivity(page) {
  if (!page || page.isClosed() || !isLiveDashboardUrl(page.url())) return false;
  const text = await page.evaluate(() => (document.body?.innerText || document.body?.textContent || "").slice(0, 5000)).catch(() => "");
  if (!text) return false;
  const normalized = text.replace(/\s+/g, " ");
  const currentViewers = normalized.match(/Current viewers\s+([0-9][0-9,.]*)/i)?.[1];
  if (!currentViewers) return false;
  const viewers = Number(currentViewers.replace(/,/g, ""));
  return Number.isFinite(viewers) && viewers > 0;
}

async function closeLiveDashboardPages(context, keepPage = null) {
  for (const page of context.pages()) {
    if (keepPage && page === keepPage) continue;
    if (!isLiveDashboardUrl(page.url())) continue;
    await page.close().catch(() => {});
  }
}

async function closeUntrackedLiveDashboardPages(context, keepPage, livePages) {
  const trackedPages = new Set(Array.from(livePages.values()).map((entry) => entry.page).filter(Boolean));
  const seenKeys = new Set();
  for (const page of context.pages()) {
    if (keepPage && page === keepPage) continue;
    if (!isLiveDashboardUrl(page.url())) continue;
    const key = livePageKey(page.url());
    if (trackedPages.has(page) && !seenKeys.has(key)) {
      seenKeys.add(key);
      continue;
    }
    await page.close().catch(() => {});
  }
}

async function openLiveStreamsMenu(page, config) {
  await dismissBlockingOverlays(page);
  await page.bringToFront().catch(() => {});
  const { selectors, liveStreamsText } = config.liveAnalytics;
  if (selectors.liveStreamsTrigger) {
    const trigger = page.locator(selectors.liveStreamsTrigger).first();
    const exists = await trigger.count().then((count) => count > 0).catch(() => false);
    if (!exists) return false;
    const hovered = await hoverElement(trigger);
    if (!hovered) return false;
    await page.waitForTimeout(1200);
    return true;
  }

  const moved = await hoverLiveStreamsByCoordinate(page, liveStreamsText || "LIVE streams");
  if (moved) return true;

  const labels = Array.from(new Set([liveStreamsText || "LIVE streams", "LIVE streams", "直播"])).filter(Boolean);
  for (const label of labels) {
    const trigger = page.getByText(label, { exact: false }).last();
    const exists = await trigger.count().then((count) => count > 0).catch(() => false);
    if (!exists) continue;
    const hovered = await hoverElement(trigger);
    if (!hovered) continue;
    await page.waitForTimeout(1200);
    return true;
  }
  await page.waitForTimeout(1200);
  return page.evaluate(() => /@[A-Za-z0-9._-]+/.test(document.body?.innerText || "")).catch(() => false);
}

async function hoverLiveStreamsByCoordinate(page, liveStreamsText) {
  const labels = Array.from(new Set([liveStreamsText || "LIVE streams", "LIVE streams", "直播"])).filter(Boolean);
  const rect = await page.evaluate((candidateLabels) => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const nodes = Array.from(document.querySelectorAll("div,button,[role='button'],[tabindex]"))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { text: textOf(node), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
      .filter((item) => item.width > 40 && item.height > 10 && item.x > window.innerWidth * 0.45)
      .filter((item) => {
        const text = item.text;
        if (/@[A-Za-z0-9._-]+/.test(text)) return false;
        if (/LIVE\s*streams\s*\+?\d*/i.test(text)) return true;
        if (/直播.*\+?\d*/.test(text)) return true;
        return candidateLabels.some((label) => text.includes(label) && /\+\s*\d+|\b\d+\b/.test(text));
      })
      .sort((a, b) => (a.width - b.width) || (b.x - a.x));
    return nodes[0] || null;
  }, labels).catch(() => null);

  if (!rect) return false;
  const y = Math.max(0, rect.y + rect.height / 2);
  const points = [
    rect.x + Math.min(12, rect.width / 3),
    rect.x + Math.min(60, rect.width / 2),
    rect.x + Math.max(rect.width - 18, rect.width / 2)
  ];
  for (const x of points) {
    await page.mouse.move(Math.max(0, x), y).catch(() => {});
    await page.waitForTimeout(700);
    const hasHandles = await page.evaluate(() => /@[A-Za-z0-9._-]+/.test(document.body?.innerText || "")).catch(() => false);
    if (hasHandles) return true;
  }
  await page.mouse.click(Math.max(0, points[0]), y).catch(() => {});
  await page.waitForTimeout(1000);
  return page.evaluate(() => /@[A-Za-z0-9._-]+/.test(document.body?.innerText || "")).catch(() => false);
}

async function hoverElement(locator) {
  try {
    await locator.hover({ timeout: 8000, force: true });
    return true;
  } catch {
    // Fall through to synthetic mouse events; some TikTok Shop rows ignore Playwright hover.
  }
  return locator.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    for (const type of ["mouseenter", "mouseover", "mousemove"]) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  }, undefined, { timeout: 3000 }).catch(() => false);
}

async function collectLiveRoomCandidates(page, config) {
  return page.evaluate(({ itemSelector }) => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 2 && rect.height > 2 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) !== 0;
    };
    const handlesIn = (value) => value.match(/@[A-Za-z0-9._-]+/g) || [];
    const looksLikeLiveListContainer = (value) => /LIVE\s*streams|What's ongoing|GMV rankings|直播/.test(value);
    const rowFor = (node, handle) => {
      let current = node;
      let fallback = null;
      while (current && current !== document.body) {
        const rect = current.getBoundingClientRect();
        const currentText = textOf(current);
        if (currentText.includes(handle) && rect.width >= 120 && rect.height >= 28 && rect.height <= 120) {
          if (handlesIn(currentText).length > 1 || looksLikeLiveListContainer(currentText)) {
            current = current.parentElement;
            continue;
          }
          const role = current.getAttribute("role") || "";
          const className = String(current.className || "");
          const clickable = typeof current.onclick === "function" || className.includes("cursor-pointer") || ["button", "link", "menuitem"].includes(role);
          if (clickable) return current;
          fallback ||= current;
        }
        current = current.parentElement;
      }
      return node.closest("a,button,[role='button'],[role='menuitem'],[tabindex]") || fallback || node;
    };
    const source = itemSelector
      ? Array.from(document.querySelectorAll(itemSelector))
      : Array.from(document.querySelectorAll("a,button,[role='button'],[role='menuitem'],[tabindex],div,span"));
    const seen = new Set();
    const candidates = [];
    const nodes = source
      .filter(visible)
      .map((node) => {
        const text = textOf(node);
        const handle = text.match(/@[A-Za-z0-9._-]+/)?.[0] || "";
        const rect = node.getBoundingClientRect();
        return { node, text, handle, area: rect.width * rect.height };
      })
      .filter((item) => item.handle && item.text && item.text.length <= 260)
      .sort((a, b) => a.area - b.area);

    for (const { node, text, handle } of nodes) {
      const clickable = rowFor(node, handle);
      const rect = clickable.getBoundingClientRect();
      if (rect.width < 100 || rect.width > 380 || rect.height < 28 || rect.height > 90) continue;
      if (rect.x < window.innerWidth * 0.55) continue;
      const clickableText = textOf(clickable);
      const rowHandles = handlesIn(clickableText);
      if (!clickableText.includes(handle)) continue;
      if (rowHandles.length !== 1 || rowHandles[0] !== handle) continue;
      if (looksLikeLiveListContainer(clickableText)) continue;
      const href = clickable.href || clickable.closest?.("a")?.href || "";
      const key = handle || href || text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      const marker = `gmvmax-live-${candidates.length + 1}`;
      clickable.setAttribute("data-gmvmax-live-candidate", marker);
      candidates.push({
        marker,
        text,
        href,
        handle,
        key,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      });
    }
    return candidates;
  }, { itemSelector: config.liveAnalytics.selectors.liveRoomItems || "" });
}

function filterCandidates(candidates, config) {
  const wanted = config.liveAnalytics.liveRoomTexts || [];
  if (!wanted.length) return candidates;
  return candidates.filter((candidate) => wanted.some((part) => candidate.text.includes(part) || candidate.href.includes(part)));
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value || "";
  }
}

function liveLabelFromUrl(value) {
  const parsed = safelyParseUrl(value);
  const roomId = parsed?.searchParams.get("room_id");
  return roomId ? `room-${roomId.slice(-6)}` : "LIVE room";
}

async function openLiveDashboardFromCandidate(context, config, candidate, index) {
  if (candidate.href) {
    const page = await context.newPage();
    await page.goto(candidate.href, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    return page;
  }

  const page = await context.newPage();
  await page.goto(config.liveAnalytics.overviewUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await acceptVisibleDialogs(page);
  const menuOpened = await openLiveStreamsMenu(page, config);
  if (!menuOpened) {
    await page.close().catch(() => {});
    return null;
  }
  const freshCandidates = filterCandidates(await collectLiveRoomCandidates(page, config), config);
  const fresh = freshCandidates.find((item) =>
    (candidate.key && item.key === candidate.key) ||
    (candidate.handle && item.handle === candidate.handle)
  );
  if (!fresh) {
    await page.close().catch(() => {});
    return null;
  }

  const opened = await clickLiveCandidate(context, page, fresh);
  if (opened && opened !== page) {
    await opened.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
    await page.close().catch(() => {});
    return opened;
  }
  if (!opened) await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  if (!isLiveDashboardUrl(page.url())) {
    await page.close().catch(() => {});
    return null;
  }
  return page;
}

async function clickLiveCandidate(context, page, candidate) {
  const locator = page.locator(`[data-gmvmax-live-candidate="${candidate.marker}"]`).first();
  const tryClick = async (clicker) => {
    const beforeUrl = page.url();
    const newPagePromise = context.waitForEvent("page", { timeout: 12_000 }).catch(() => null);
    const clicked = await clicker().then(() => true).catch(() => false);
    if (!clicked) return { clicked: false, opened: null };
    const opened = await newPagePromise;
    if (opened) return { clicked: true, opened };
    await page.waitForTimeout(500);
    if (page.url() !== beforeUrl && isLiveDashboardUrl(page.url())) return { clicked: true, opened: page };
    return { clicked: true, opened: null };
  };

  const locatorResult = await tryClick(() => locator.click({ timeout: 10_000, force: true }));
  if (locatorResult.opened) return locatorResult.opened;
  if (locatorResult.clicked) return null;

  const rect = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }).catch(() => candidate.rect);
  if (!rect) {
    return (await tryClick(() => locator.click({ timeout: 15_000, force: true }))).opened;
  }
  const y = rect.y + rect.height / 2;
  return (await tryClick(() => page.mouse.click(rect.x + Math.min(48, rect.width / 2), y))).opened;
}

async function collectLivePage(page, timestamp, config, outputDir, labelOverride = "", attempt = 0) {
  const originalUrl = page.url();
  await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
  const networkMetrics = await captureLiveMetricsFromNetwork(page, async () => {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
    if (!isLiveDashboardUrl(page.url()) && isLiveDashboardUrl(originalUrl)) {
      await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
    }
  });
  if (!isLiveDashboardUrl(page.url())) {
    throw new Error(`Expected LIVE dashboard, got ${page.url()}`);
  }
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await acceptVisibleDialogs(page);
  await hoverMetricsPanel(page, config);

  const extracted = await page.evaluate(extractLiveDashboardMetrics, {
    selectors: config.liveAnalytics.selectors
  });
  const metrics = extracted.metrics || {};
  const attributedGmv = metrics.attributedGmv || networkMetrics.attributedGmv || "";
  const adsCost = metrics.adsCost || networkMetrics.adsCost || "";
  const gmvMaxRoi = metrics.gmvMaxRoi || networkMetrics.gmvMaxRoi || computeGmvMaxRoi(attributedGmv, adsCost);
  const record = {
    timestamp,
    room: labelOverride || extracted.roomName,
    currentViewers: metrics.currentViewers || networkMetrics.currentViewers || "",
    tapThroughRateViaLivePreview: metrics.tapThroughRateViaLivePreview || networkMetrics.tapThroughRateViaLivePreview || "",
    tapThroughRate: metrics.tapThroughRate || networkMetrics.tapThroughRate || "",
    liveCtr: metrics.liveCtr || networkMetrics.liveCtr || "",
    orderRateSkuOrders: metrics.orderRateSkuOrders || networkMetrics.orderRateSkuOrders || "",
    adsCost,
    gmvMaxRoi,
    url: extracted.url
  };

  const missing = Object.entries(record).filter(([key, value]) => !["timestamp", "url"].includes(key) && !value);
  if (missing.length > 0) {
    const criticalMissing = missing.filter(([key]) => key !== "room");
    if (criticalMissing.length >= 4 && attempt < 1) {
      console.warn(`[${PREFIX}] ${record.room} returned incomplete LIVE metrics (${criticalMissing.map(([key]) => key).join(", ")}). Retrying once without changing dashboard metrics.`);
      await page.waitForTimeout(2000).catch(() => {});
      return collectLivePage(page, timestamp, config, outputDir, labelOverride, attempt + 1);
    }
    const safeStamp = `${timestamp}-${slug(record.room || "live")}`.replace(/[:.]/g, "-");
    await fs.writeFile(path.join(outputDir, `live-debug-${safeStamp}.txt`), extracted.bodyText || "", "utf8");
    await fs.writeFile(path.join(outputDir, `live-debug-${safeStamp}-network.json`), JSON.stringify(networkMetrics, null, 2), "utf8").catch(() => {});
    await page.screenshot({ path: path.join(outputDir, `live-debug-${safeStamp}.png`), fullPage: true }).catch(() => {});
    console.warn(`[${PREFIX}] Missing ${missing.map(([key]) => key).join(", ")} for ${record.room}. Debug files saved.`);
    if (criticalMissing.length > 0) return null;
  }
  return record;
}

async function captureLiveMetricsFromNetwork(page, action) {
  const captured = [];
  const onResponse = async (response) => {
    const url = response.url();
    if (!/seller-my\.tiktok\.com/i.test(url)) return;
    if (!/live|metric|analytics|dashboard|compass|workbench/i.test(url)) return;
    const contentType = response.headers()["content-type"] || "";
    if (!/json/i.test(contentType)) return;
    try {
      const payload = await response.json();
      const metrics = extractMetricsFromPayload(payload);
      if (Object.values(metrics).some(Boolean)) {
        captured.push({ url, metrics });
      }
    } catch {
      // Some TikTok responses advertise JSON but stream/encode in a way Playwright cannot parse.
    }
  };

  page.on("response", onResponse);
  try {
    await action();
    await page.waitForTimeout(2500);
  } finally {
    page.off("response", onResponse);
  }

  return captured.reduce((merged, item) => ({ ...merged, ...emptyOnlyMerge(merged, item.metrics) }), {});
}

function emptyOnlyMerge(existing, incoming) {
  const result = {};
  for (const [key, value] of Object.entries(incoming || {})) {
    if (!existing[key] && value) result[key] = value;
  }
  return result;
}

function extractMetricsFromPayload(payload) {
  const metrics = {};
  const seen = new Set();
  const aliases = [
    ["attributedGmv", [/attributed\s*gmv/i, /gmv.*attributed/i]],
    ["currentViewers", [/current\s*viewers?/i, /online\s*viewers?/i, /viewer\s*count/i, /current_view/i]],
    ["tapThroughRateViaLivePreview", [/tap[-\s]*through.*live\s*preview/i, /live\s*preview.*tap/i]],
    ["tapThroughRate", [/^tap[-\s]*through\s*rate$/i, /product.*click.*rate/i]],
    ["liveCtr", [/^live\s*ctr$/i]],
    ["orderRateSkuOrders", [/order\s*rate.*sku/i, /sku.*order\s*rate/i]],
    ["adsCost", [/ads?\s*cost/i, /ad\s*cost/i, /cost.*ads?/i]],
    ["gmvMaxRoi", [/gmv\s*max\s*roi/i, /gmvmaxroi/i]],
  ];

  const visit = (value, path = []) => {
    if (value == null) return;
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, path);
      return;
    }

    const entries = Object.entries(value);
    const labelText = metricLabelText(value, path);
    for (const [metricKey, patterns] of aliases) {
      if (!metrics[metricKey] && patterns.some((pattern) => pattern.test(labelText))) {
        const metricValue = findMetricValue(value);
        if (metricValue) metrics[metricKey] = metricValue;
      }
    }

    for (const [key, child] of entries) {
      const keyText = [...path, key].join(" ");
      for (const [metricKey, patterns] of aliases) {
        if (!metrics[metricKey] && patterns.some((pattern) => pattern.test(keyText))) {
          const metricValue = primitiveMetricValue(child) || findMetricValue(child);
          if (metricValue) metrics[metricKey] = metricValue;
        }
      }
      visit(child, [...path, key]);
    }
  };

  visit(payload);
  return metrics;
}

function metricLabelText(value, path) {
  const labelKeys = ["name", "title", "label", "display_name", "displayName", "metric_name", "metricName", "field", "key", "type"];
  const parts = [...path];
  for (const key of labelKeys) {
    if (typeof value?.[key] === "string") parts.push(value[key]);
  }
  return parts.join(" ").replace(/[_-]+/g, " ");
}

function findMetricValue(value) {
  if (value == null) return "";
  const primitive = primitiveMetricValue(value);
  if (primitive) return primitive;
  if (typeof value !== "object") return "";

  const valueKeys = ["value", "val", "current", "current_value", "currentValue", "metric_value", "metricValue", "rate", "amount", "num", "count"];
  for (const key of valueKeys) {
    const found = primitiveMetricValue(value[key]);
    if (found) return found;
  }

  for (const child of Object.values(value)) {
    const found = primitiveMetricValue(child);
    if (found) return found;
  }
  return "";
}

function primitiveMetricValue(value) {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text || text.length > 40) return "";
  return /[-+]?\d/.test(text) ? text : "";
}

function computeGmvMaxRoi(attributedGmv, adsCost) {
  const gmv = parseMetricNumber(attributedGmv);
  const cost = parseMetricNumber(adsCost);
  if (!Number.isFinite(gmv) || !Number.isFinite(cost) || cost <= 0) return "";
  return (gmv / cost).toFixed(2).replace(/\.?0+$/, "");
}

function parseMetricNumber(value) {
  if (typeof value === "number") return value;
  if (value == null) return NaN;
  const text = String(value).trim().replace(/^RM\s*/i, "");
  const multiplier = /K\s*$/i.test(text) ? 1_000 : /M\s*$/i.test(text) ? 1_000_000 : 1;
  const normalized = text.replace(/[KM]/gi, "").replace(/,/g, "").replace(/\s+/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number * multiplier : NaN;
}

async function hoverMetricsPanel(page, config) {
  const selector = config.liveAnalytics.selectors.metricHover;
  if (selector) {
    await page.locator(selector).first().hover({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    return;
  }

  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(Math.floor(viewport.width * 0.52), Math.floor(viewport.height * 0.28)).catch(() => {});
  await page.waitForTimeout(1200);

  for (const label of ["Attributed GMV", "Current viewers", "GMV Max ROI", "Ads Cost"]) {
    const locator = page.getByText(label, { exact: false }).first();
    if (await locator.count().catch(() => 0)) {
      await locator.hover({ timeout: 5000, force: true }).catch(() => {});
      await page.waitForTimeout(800);
      return;
    }
  }

  await page.mouse.move(Math.floor(viewport.width * 0.52), Math.floor(viewport.height * 0.44)).catch(() => {});
  await page.waitForTimeout(800);
}

async function ensureTapThroughMetricsVisible(page) {
  // Intentionally disabled: data collection must not change LIVE dashboard Custom metrics.
  return;
  const requiredLabels = ["Tap-through rate (via LIVE preview)", "Tap-through rate", "Ads Cost", "GMV Max ROI"];
  const missingCardLabels = await page.evaluate((requiredLabels) => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const keyMetricCard = Array.from(document.querySelectorAll("div"))
      .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
      .filter((item) =>
        item.text.includes("Attributed GMV") &&
        item.text.includes("Current viewers") &&
        item.rect.width > 500 &&
        item.rect.height > 220
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
    const cardText = keyMetricCard?.text || "";
    const hasLabel = (label) => {
      if (label.includes("via LIVE")) return /Tap-through rate\s*\(via\s+LIVE/i.test(cardText);
      if (label === "Tap-through rate") return /\bTap-through rate\b(?!\s*\(via\s+LIVE)/i.test(cardText);
      return cardText.includes(label);
    };
    return requiredLabels.filter((label) => !hasLabel(label));
  }, requiredLabels).catch(() => requiredLabels);
  if (missingCardLabels.length === 0) return;

  const editPoint = await page.evaluate(() => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const keyMetricCard = Array.from(document.querySelectorAll("div"))
      .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
      .filter((item) =>
        item.text.includes("Attributed GMV") &&
        item.text.includes("Current viewers") &&
        item.rect.width > 500 &&
        item.rect.height > 220
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
    if (!keyMetricCard) return null;

    const cardRect = keyMetricCard.rect;
    const editIcon = Array.from(keyMetricCard.node.querySelectorAll("svg, [class*='edit'], [class*='Edit']"))
      .map((node) => ({ node, rect: node.getBoundingClientRect(), className: String(node.className?.baseVal || node.className || "") }))
      .filter((item) => /edit/i.test(item.className) && item.rect.width >= 8 && item.rect.height >= 8)
      .sort((a, b) => a.rect.top - b.rect.top || b.rect.left - a.rect.left)[0];
    if (editIcon) {
      const button = editIcon.node.closest("button, [role='button']");
      const rect = (button || editIcon.node).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }

    const buttons = Array.from(keyMetricCard.node.querySelectorAll("button, [role='button']"))
      .map((node) => ({ node, rect: node.getBoundingClientRect(), text: textOf(node) }))
      .filter((item) => item.rect.width >= 8 && item.rect.height >= 8)
      .sort((a, b) => a.rect.top - b.rect.top || b.rect.left - a.rect.left);
    const target = buttons[0]?.rect;
    if (target) {
      return { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    }
    return { x: cardRect.right - 40, y: cardRect.top + 40 };
  }).catch(() => false);

  if (!editPoint) return;
  await page.mouse.click(editPoint.x, editPoint.y).catch(() => {});
  await page.waitForTimeout(1200);

  const editorOpened = await page.evaluate(() => /Select metrics \(up to 16\)|Custom metrics/i.test(document.body?.innerText || "")).catch(() => false);
  if (!editorOpened) {
    console.warn(`[${PREFIX}] Custom metrics editor did not open; Tap-through metrics remain hidden.`);
    return;
  }

  const desiredMetricLabels = [
    "Tap-through rate (via LIVE preview)",
    "Tap-through rate",
    "LIVE CTR",
    "Order rate (SKU orders)",
    "Ads Cost",
    "GMV Max ROI",
    "AOV",
    "Payment Rate",
    "Est. GMV",
    "CTOR (SKU orders)",
    "Product clicks",
    "Customers",
    "GMV per hour",
    "Show GPM",
    "Comment rate",
    "Like rate",
  ];

  const removableExtraLabels = [
    "GMV with subsidies",
    "CTOR",
    "Comments",
    "New followers",
    "Watch GPM",
    "Follow rate",
    "Share rate",
    "Avg. viewing duration",
    "Avg. viewing duration per view",
    "> 1 min. views",
    "Views",
    "Impressions",
    "Impressions per hour",
  ];

  const getSelectedMetricState = async () => page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const countMatch = bodyText.match(/(\d+)\s+metrics selected/i);
    const selectedText = bodyText.split(/\d+\s+metrics selected/i)[1]?.split(/\bCancel\b|\bApply\b|取消|应用|确定|确认/i)[0] || "";
    const selectedMetrics = selectedText
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return {
      count: countMatch ? Number(countMatch[1]) : 0,
      selectedText,
      selectedMetrics,
    };
  }).catch(() => ({ count: 0, selectedText: "", selectedMetrics: [] }));

  const selectedMetricMatches = (metric, label) => {
    if (label === "Tap-through rate") return metric === label;
    if (metric === label || metric.startsWith(label)) return true;
    return label.includes("via LIVE") && metric.includes("Tap-through rate") && metric.includes("LIVE") && metric.includes("preview");
  };

  const selectedStateHasLabel = (state, label) => {
    if (state.selectedMetrics.some((metric) => selectedMetricMatches(metric, label))) return true;
    const text = state.selectedText.replace(/\s+/g, " ");
    if (label.includes("via LIVE")) return /Tap-through rate\s*\(via\s+LIVE\s+preview\)/i.test(text);
    if (label === "Tap-through rate") return /\bTap-through rate\b(?!\s*\(via\s+LIVE)/i.test(text);
    return text.includes(label);
  };

  const isSelected = async (label) => {
    const state = await getSelectedMetricState();
    return selectedStateHasLabel(state, label);
  };

  const metricClickPoint = async (label, mode) => page.evaluate(({ label, mode }) => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const isVisible = (rect) => rect.width > 2 && rect.height > 2 && rect.bottom > 0 && rect.right > 0;
    const modal = Array.from(document.querySelectorAll("div"))
      .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
      .filter((item) =>
        item.text.includes("Custom metrics") &&
        item.text.includes("Select metrics") &&
        item.rect.width > 800 &&
        item.rect.height > 500 &&
        isVisible(item.rect)
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
    if (!modal) return null;

    const modalRect = modal.rect;
    const selectedBoundary = modalRect.left + modalRect.width * 0.72;
    const matchesLabel = (text) => {
      if (label === "Tap-through rate") return text === label;
      if (label.includes("via LIVE")) return text.includes("Tap-through rate") && text.includes("LIVE") && text.includes("preview");
      if (text === label || text.startsWith(label)) return true;
      return false;
    };

    const candidates = Array.from(modal.node.querySelectorAll("*"))
      .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
      .filter((item) => matchesLabel(item.text) && isVisible(item.rect));

    const candidate = candidates
      .filter((item) => mode === "remove" ? item.rect.left > selectedBoundary : item.rect.left < selectedBoundary)
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
    if (!candidate) return null;

    let row = candidate.node;
    for (let i = 0; i < 6 && row?.parentElement; i += 1) {
      const rect = row.getBoundingClientRect();
      const text = textOf(row);
      if (
        matchesLabel(text) &&
        rect.width > 120 &&
        rect.height >= 24 &&
        rect.height <= 90 &&
        isVisible(rect)
      ) {
        const x = mode === "remove" ? rect.right - 18 : rect.left + 12;
        return { x, y: rect.top + rect.height / 2 };
      }
      row = row.parentElement;
    }

    const rect = candidate.rect;
    const x = mode === "remove" ? rect.right + 24 : rect.left - 18;
    return { x, y: rect.top + rect.height / 2 };
  }, { label, mode }).catch(() => null);

  const clickMetric = async (label, mode) => {
    if (mode === "select") {
      const clicked = await page.evaluate((label) => {
        const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
        const visible = (node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 2 && rect.height > 2 && style.visibility !== "hidden" && style.display !== "none";
        };
        const modal = Array.from(document.querySelectorAll("div"))
          .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
          .filter((item) =>
            item.text.includes("Custom metrics") &&
            item.text.includes("Select metrics") &&
            item.rect.width > 800 &&
            item.rect.height > 500
          )
          .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
        if (!modal) return false;

        const selectedBoundary = modal.rect.left + modal.rect.width * 0.72;
        const matchesLabel = (text) => {
          if (label === "Tap-through rate") return text === label;
          if (label.includes("via LIVE")) return text.includes("Tap-through rate") && text.includes("LIVE") && text.includes("preview");
          if (text === label || text.startsWith(label)) return true;
          return false;
        };
        const candidate = Array.from(modal.node.querySelectorAll("label, [class*='checkbox'], span, div"))
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            const style = window.getComputedStyle(node);
            return rect.width > 2 && rect.height > 2 && style.visibility !== "hidden" && style.display !== "none";
          })
          .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
          .filter((item) => matchesLabel(item.text) && item.rect.left < selectedBoundary)
          .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
        if (!candidate) return false;

        const target = candidate.node.closest("label") || candidate.node;
        target.scrollIntoView({ block: "center", inline: "nearest" });
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      }, label).catch(() => false);
      if (clicked) {
        await page.waitForTimeout(450);
        return true;
      }
    }

    if (mode === "remove") {
      const rect = await page.evaluate((label) => {
        const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
        const visible = (node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 2 && rect.height > 2 && style.visibility !== "hidden" && style.display !== "none";
        };
        const modal = Array.from(document.querySelectorAll("div"))
          .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
          .filter((item) =>
            item.text.includes("Custom metrics") &&
            item.text.includes("Select metrics") &&
            item.rect.width > 800 &&
            item.rect.height > 500
          )
          .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
        if (!modal) return null;

        const selectedBoundary = modal.rect.left + modal.rect.width * 0.72;
        const candidate = Array.from(modal.node.querySelectorAll("div, p, span"))
          .filter(visible)
          .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
          .filter((item) => item.text === label && item.rect.left > selectedBoundary)
          .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
        if (!candidate) return null;

        let row = candidate.node;
        for (let i = 0; i < 6 && row; i += 1) {
          const rowText = textOf(row);
          const rowRect = row.getBoundingClientRect();
          if (rowText === label && rowRect.width > 180 && rowRect.height > 36) {
            row.scrollIntoView({ block: "center", inline: "nearest" });
            const scrolled = row.getBoundingClientRect();
            return { x: scrolled.x, y: scrolled.y, width: scrolled.width, height: scrolled.height };
          }
          row = row.parentElement;
        }
        return null;
      }, label).catch(() => null);
      if (rect) {
        await page.mouse.click(rect.x + rect.width - 16, rect.y + rect.height / 2).catch(() => {});
        await page.waitForTimeout(450);
        return true;
      }
    }

    const point = await metricClickPoint(label, mode);
    if (!point) return false;
    await page.mouse.click(point.x, point.y).catch(() => {});
    await page.waitForTimeout(350);
    return true;
  };

  let changed = false;
  const initialState = await getSelectedMetricState();
  console.log(`[${PREFIX}] Custom metrics selected count before Tap-through sync: ${initialState.count}.`);
  for (const label of removableExtraLabels) {
    if (await isSelected(label)) {
      const removed = await clickMetric(label, "remove");
      console.log(`[${PREFIX}] ${removed ? "Removed" : "Could not remove"} non-restored metric: ${label}`);
      changed = removed || changed;
    }
  }

  for (const label of desiredMetricLabels) {
    if (await isSelected(label)) {
      const removed = await clickMetric(label, "remove");
      console.log(`[${PREFIX}] ${removed ? "Temporarily removed" : "Could not temporarily remove"} metric for ordering: ${label}`);
      changed = removed || changed;
    }
  }

  for (const label of desiredMetricLabels) {
    if (!(await isSelected(label))) {
      const selected = await clickMetric(label, "select");
      console.log(`[${PREFIX}] ${selected ? "Restored" : "Could not restore"} metric: ${label}`);
      changed = selected || changed;
    }
  }

  let repairedState = await getSelectedMetricState();
  const missingDesiredLabels = desiredMetricLabels.filter((label) => !selectedStateHasLabel(repairedState, label));
  if (missingDesiredLabels.length > 0 && repairedState.count >= 16) {
    const extraSelectedLabels = repairedState.selectedMetrics.filter((metric) =>
      !desiredMetricLabels.some((label) => selectedMetricMatches(metric, label))
    );
    for (const label of extraSelectedLabels) {
      const removed = await clickMetric(label, "remove");
      console.log(`[${PREFIX}] ${removed ? "Removed" : "Could not remove"} extra metric while restoring: ${label}`);
      changed = removed || changed;
    }
    for (const label of missingDesiredLabels) {
      if (!(await isSelected(label))) {
        const selected = await clickMetric(label, "select");
        console.log(`[${PREFIX}] ${selected ? "Restored" : "Could not restore"} missing metric after repair: ${label}`);
        changed = selected || changed;
      }
    }
  }

  const finalState = await getSelectedMetricState();
  const hasRequired = requiredLabels.every((label) =>
    selectedStateHasLabel(finalState, label)
  );
  if (!hasRequired) {
    const missingRequired = requiredLabels.filter((label) => !selectedStateHasLabel(finalState, label));
    console.warn(`[${PREFIX}] Required LIVE metrics were not selected (${missingRequired.join(", ")}). Current selected metrics: ${finalState.selectedText.replace(/\s+/g, " ").trim()}`);
    const cancel = page.getByText(/Cancel|取消/).last();
    if (await cancel.count().catch(() => 0)) await cancel.click({ timeout: 2000, force: true }).catch(() => {});
    return;
  }

  const apply = page.getByText(/Apply|应用|确定|确认/).last();
  if (await apply.count().catch(() => 0)) {
    await apply.click({ timeout: 3000, force: true }).catch(() => {});
    changed = true;
  }

  if (changed) {
    await page.waitForTimeout(1800);
    await hoverMetricsPanel(page, { liveAnalytics: { selectors: {} } }).catch(() => {});
  }
}

async function acceptVisibleDialogs(page) {
  const buttons = ["Accept all", "Accept", "同意", "接受", "我知道了", "Got it", "Dismiss", "Skip", "Not now", "Later"];
  await page.evaluate((names) => {
    const elements = Array.from(document.querySelectorAll("button, [role='button']"));
    for (const element of elements) {
      const text = (element.innerText || element.textContent || "").trim();
      if (names.some((name) => text.includes(name))) element.click();
    }
  }, buttons).catch(() => {});
  await dismissBlockingOverlays(page);
}

async function dismissBlockingOverlays(page) {
  await page.evaluate(() => {
    const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const overlays = Array.from(document.querySelectorAll("[class*='popover'], [class*='tour'], [class*='tooltip'], [role='dialog']"));
    for (const overlay of overlays) {
      const text = textOf(overlay);
      if (!/low stock|tour|guide|notification|products with low stock/i.test(text)) continue;
      const close = Array.from(overlay.querySelectorAll("button, [role='button'], svg, [class*='close']"))
        .find((node) => /close|dismiss|skip|got it|我知道|关闭/i.test(textOf(node)) || node.tagName.toLowerCase() === "svg");
      close?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      if (overlay.isConnected) overlay.style.pointerEvents = "none";
    }
  }).catch(() => {});
}

async function appendJsonl(filePath, value) {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function appendLiveCsv(filePath, records) {
  const exists = await fileExists(filePath);
  if (!exists) {
    await fs.appendFile(filePath, [
      "timestamp",
      "room",
      "current_viewers",
      "tap_through_rate_via_live_preview",
      "tap_through_rate",
      "live_ctr",
      "order_rate_sku_orders",
      "ads_cost",
      "gmv_max_roi",
      "url"
    ].join(",") + "\n", "utf8");
  }

  for (const record of records) {
    const row = [
      record.timestamp,
      record.room,
      record.currentViewers,
      record.tapThroughRateViaLivePreview,
      record.tapThroughRate,
      record.liveCtr,
      record.orderRateSkuOrders,
      record.adsCost,
      record.gmvMaxRoi,
      record.url
    ].map(csvCell);
    await fs.appendFile(filePath, `${row.join(",")}\n`, "utf8");
  }
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function slug(value) {
  return String(value || "").replace(/[^a-z0-9@._-]+/gi, "-").slice(0, 80);
}

async function safeTitle(page) {
  try { return await page.title(); } catch { return ""; }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
