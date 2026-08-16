import { expect, type Page, type Request, test } from "@playwright/test";

/**
 * PRDCT-11466 — Endpoint Scanner page Version filter, acceptance suite.
 *
 * Driven against the real running stack: this React app (Vite, PR code) →
 * crud_service running in the Tilt Kind cluster (PR code, live-synced) → Postgres.
 *
 * Seeded fixture (see e2e-seed-scanner-versions.sql), 6 devices:
 *   e2e-dev-a  historical 1.2.0 + latest 1.4.2
 *   e2e-dev-b  1.4.2
 *   e2e-dev-c  2026-07-30-1015-4f2c9d1   (staging date-id form; shortVersion → 2026-07-30-1015)
 *   e2e-dev-d  1.2.0
 *   e2e-dev-f  latest scan has NO version (the "Unknown" bucket)
 *   e2e-dev-g  ONE run: host 3.0.0-host (older) + container 3.0.0-container (newer)
 *   e2e-dev-h  only scan is 30 days old — outside the page's default Last-7-days window
 */

const V_NEW = "1.4.2";
const V_OLD = "1.2.0";
const V_OTHER = "2026-07-30-1015-4f2c9d1";
const V_OTHER_SHORT = "2026-07-30-1015";
const V_HOST = "3.0.0-host";
const V_CONTAINER = "3.0.0-container";
const V_STALE = "0.9.0-stale";

const ALL_DEVICES = ["e2e-dev-a", "e2e-dev-b", "e2e-dev-c", "e2e-dev-d", "e2e-dev-f", "e2e-dev-g"];

const LIST_PATH = "/api/crud/v1/scanner-installations";

type ListCall = { url: URL; versions: string[]; unknown: string | null };

/** Records every scanner-installations LIST request (not the /versions facet). */
function trackListCalls(page: Page): ListCall[] {
  const calls: ListCall[] = [];
  page.on("request", (req: Request) => {
    const url = new URL(req.url());
    // Exactly the list endpoint — NOT its facet siblings (/versions, /devices, /users,
    // /device-owners), which the Filters dropdown fetches and which carry no version params.
    if (url.pathname.replace(/\/$/, "") !== LIST_PATH) return;
    calls.push({
      url,
      versions: url.searchParams.getAll("scanner_versions"),
      unknown: url.searchParams.get("include_unknown_scanner_versions"),
    });
  });
  return calls;
}

async function openPage(page: Page, path: string) {
  // The Version column + filter are gated on the `scanner-version-control` LD flag;
  // in dev the client honours a localStorage override, so pin it ON deterministically.
  await page.addInitScript(() => {
    localStorage.setItem("ld-flag-overrides", JSON.stringify({ scannerVersionControl: true }));
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  // The route lazy-compiles on first hit and the box is shared with the Tilt cluster, so wait
  // for the toolbar to actually exist rather than trusting networkidle alone.
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible({ timeout: 60_000 });
}

async function visibleDevices(page: Page): Promise<string[]> {
  const rows = await page.locator("tbody tr").allInnerTexts();
  return ALL_DEVICES.filter((name) => rows.some((r) => r.includes(name)));
}

/** The table re-fetches on every filter change; poll rather than race the render. */
async function expectDevices(page: Page, expected: string[]) {
  await expect.poll(() => visibleDevices(page), { timeout: 20_000 }).toEqual(expected);
}

/** Poll the LAST list request until it carries the expected version params. */
async function expectLastListCall(calls: ListCall[], versions: string[], unknown: string | null) {
  await expect
    .poll(() => ({ versions: [...(calls.at(-1)?.versions ?? [])].sort(), unknown: calls.at(-1)?.unknown ?? null }), {
      timeout: 20_000,
    })
    .toEqual({ versions: [...versions].sort(), unknown });
}

/**
 * After a clear, TanStack Query may serve the already-cached unfiltered page without a new
 * request — so assert the invariant that actually matters: no list request issued from here on
 * carries a version param.
 */
async function expectNoVersionedCallsAfter(calls: ListCall[], mark: number) {
  await expect
    .poll(() => calls.slice(mark).filter((c) => c.versions.length > 0 || c.unknown !== null).length, { timeout: 5_000 })
    .toBe(0);
}

/** The Version pill's own X — the toolbar also carries a default Last Scan pill with one. */
function versionPillReset(page: Page) {
  return page
    .getByRole("button", { name: /^Version is/ })
    .locator("xpath=..")
    .getByRole("button", { name: "Reset filter" });
}

/** Opens Filters → Version and returns the panel locator. */
async function openVersionFilter(page: Page) {
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  // Scope to the filter menu's category button — the table's sortable "Version" column header
  // is also an accessible button named "Version".
  await page
    .locator("button.w-full")
    .filter({ hasText: /^Version$/ })
    .click();
  const panel = page.getByPlaceholder("Search versions...");
  await expect(panel).toBeVisible();
  return panel;
}

async function versionOptions(page: Page): Promise<string[]> {
  await expect(page.getByRole("option").first()).toBeVisible();
  const labels = await page.getByRole("option").allInnerTexts();
  return labels.map((l) => l.trim()).filter((l) => l && !/^(Select All|Deselect All|Clear Filter)$/.test(l));
}

/**
 * The synthetic "Unknown" row renders before the facet request resolves, so a single read can
 * catch the list mid-flight. Poll until the option set settles on what is asserted.
 */
async function expectVersionOptions(page: Page, expected: string[]) {
  await expect.poll(() => versionOptions(page).then((o) => [...o].sort()), { timeout: 20_000 }).toEqual(
    [...expected].sort()
  );
}

async function chooseVersion(page: Page, label: string) {
  await page.getByRole("option", { name: label, exact: true }).click();
}

test.describe("PRDCT-11466 Endpoint Scanner Version filter", () => {
  test("at9 — options are scoped by the active scan window", async ({ page }) => {
    await openPage(page, "/integrations/scanner");
    // The page defaults to Last 7 days, so e2e-dev-h (last scanned 30 days ago) is not listed.
    await expectDevices(page, ALL_DEVICES);

    await openVersionFilter(page);
    // ...and its version is not offered — it would filter to zero rows under this window.
    await expectVersionOptions(page, ["Unknown", V_NEW, V_OLD, V_OTHER_SHORT, V_HOST]);
    expect(await versionOptions(page)).not.toContain(V_STALE);
    await page.screenshot({ path: "artifacts/at9-01-options-scoped-by-window.png" });
  });

  test("at1 — the filter exists and matches the Browser Extension page's Version filter", async ({ page }) => {
    const calls = trackListCalls(page);
    await openPage(page, "/integrations/scanner");

    // Guard: the unfiltered list carries no version params and returns every seeded device.
    // The first test pays Vite's lazy route compile, so wait for the list request rather than
    // assuming networkidle already covered it (this also stops expectLastListCall from passing
    // vacuously on an empty call list).
    await expect.poll(() => calls.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expectLastListCall(calls, [], null);
    await expectDevices(page, ALL_DEVICES);
    await page.screenshot({ path: "artifacts/at1-01-scanner-unfiltered.png", fullPage: false });

    // Scanner page: Filters → Version opens the faceted version picker.
    await openVersionFilter(page);
    const scannerInventory = {
      searchInput: await page.getByPlaceholder("Search versions...").count(),
      unknownOption: await page.getByRole("option", { name: "Unknown", exact: true }).count(),
      clearAffordance: await page.getByRole("option", { name: /Clear Filter/ }).count(),
      selectAll: await page.getByRole("option", { name: /Select All/ }).count(),
    };
    await page.screenshot({ path: "artifacts/at1-02-scanner-version-filter-open.png" });
    expect(scannerInventory.searchInput).toBe(1);
    expect(scannerInventory.unknownOption).toBe(1);

    // Applied-pill shape on the scanner page.
    await chooseVersion(page, V_NEW);
    await page.keyboard.press("Escape");
    const scannerPill = page.getByRole("button", { name: /^Version is/ });
    await expect(scannerPill).toBeVisible();
    await expect(versionPillReset(page)).toBeVisible();
    await page.screenshot({ path: "artifacts/at1-03-scanner-version-pill.png" });

    // Browser Extension page: the same control, same affordances (both now render the
    // shared VersionFacetFilter — this is the ticket's consistency requirement).
    await openPage(page, "/integrations/browser-extension");
    await openVersionFilter(page);
    const extensionInventory = {
      searchInput: await page.getByPlaceholder("Search versions...").count(),
      unknownOption: await page.getByRole("option", { name: "Unknown", exact: true }).count(),
      clearAffordance: await page.getByRole("option", { name: /Clear Filter/ }).count(),
      selectAll: await page.getByRole("option", { name: /Select All/ }).count(),
    };
    // Each page is bound to its OWN facet through the shared component: the extension filter
    // lists the extension's real versions (seeded 2.7.1 ×2, 2.6.0 ×1, one NULL), not the
    // scanner's — same control, same affordances, different data.
    await expectVersionOptions(page, ["Unknown", "2.7.1", "2.6.0"]);
    await page.screenshot({ path: "artifacts/at1-04-extension-version-filter-open.png" });
    expect(extensionInventory).toEqual(scannerInventory);
  });

  test("at2 — selecting a version narrows the list server-side; multi-select unions", async ({ page }) => {
    const calls = trackListCalls(page);
    await openPage(page, "/integrations/scanner");
    await expectDevices(page, ALL_DEVICES);

    await openVersionFilter(page);
    await chooseVersion(page, V_NEW);
    await page.keyboard.press("Escape");
    await page.waitForLoadState("networkidle");

    // The narrowing happened on the server, not in the browser.
    await expectLastListCall(calls, [V_NEW], null);
    await expectDevices(page, ["e2e-dev-a", "e2e-dev-b"]);
    await page.screenshot({ path: "artifacts/at2-01-filtered-v_new.png" });

    // Multi-select unions the sets, in ONE request carrying both values.
    await openVersionFilter(page);
    await chooseVersion(page, V_OTHER_SHORT);
    await page.keyboard.press("Escape");
    await page.waitForLoadState("networkidle");

    await expectLastListCall(calls, [V_NEW, V_OTHER], null);
    await expectDevices(page, ["e2e-dev-a", "e2e-dev-b", "e2e-dev-c"]);
    await page.screenshot({ path: "artifacts/at2-02-filtered-multi.png" });
  });

  test("at3 — a version that is only in a device's HISTORICAL scan never matches", async ({ page }) => {
    const calls = trackListCalls(page);
    await openPage(page, "/integrations/scanner");

    await openVersionFilter(page);
    await chooseVersion(page, V_OLD);
    await page.keyboard.press("Escape");
    await page.waitForLoadState("networkidle");

    await expectLastListCall(calls, [V_OLD], null);
    // e2e-dev-a HAS a 1.2.0 scan, but its LATEST is 1.4.2 — it must be absent.
    await expectDevices(page, ["e2e-dev-d"]);
    await page.screenshot({ path: "artifacts/at3-01-filtered-v_old-A-absent.png" });
  });

  test("at4 — options reflect the real data, incl. the representative (host) row of a split run", async ({ page }) => {
    await openPage(page, "/integrations/scanner");

    await expectDevices(page, ALL_DEVICES);

    // The Version column shows e2e-dev-g's HOST build, even though its container row is newer.
    const gRow = page.locator("tbody tr", { hasText: "e2e-dev-g" });
    await expect(gRow).toContainText(V_HOST);
    await expect(gRow).not.toContainText(V_CONTAINER);

    await openVersionFilter(page);
    // Every latest-scan version is offered, exactly once, plus the synthetic Unknown bucket —
    // and the version carried ONLY by the non-representative row of the split run is absent,
    // because it would filter to zero devices.
    await expectVersionOptions(page, ["Unknown", V_NEW, V_OLD, V_OTHER_SHORT, V_HOST]);
    await page.screenshot({ path: "artifacts/at4-01-version-options.png" });
    expect(await versionOptions(page)).not.toContain(V_CONTAINER);

    // And the offered host build does return its device.
    await chooseVersion(page, V_HOST);
    await page.keyboard.press("Escape");
    await page.waitForLoadState("networkidle");
    await expectDevices(page, ["e2e-dev-g"]);
    await page.screenshot({ path: "artifacts/at4-02-filtered-v_host.png" });
  });

  test("at5 — the Unknown bucket matches the NULL-version device", async ({ page }) => {
    const calls = trackListCalls(page);
    await openPage(page, "/integrations/scanner");

    await openVersionFilter(page);
    await chooseVersion(page, "Unknown");
    await page.keyboard.press("Escape");
    await page.waitForLoadState("networkidle");

    await expectLastListCall(calls, [], "true");
    await expectDevices(page, ["e2e-dev-f"]);
    await page.screenshot({ path: "artifacts/at5-01-filtered-unknown.png" });
  });

  test("at6 — per-filter clear and the toolbar Reset All each restore the full list", async ({ page }) => {
    const calls = trackListCalls(page);
    await openPage(page, "/integrations/scanner");

    // --- per-filter clear ---
    await openVersionFilter(page);
    await chooseVersion(page, V_NEW);
    await page.keyboard.press("Escape");
    await page.waitForLoadState("networkidle");
    await expectDevices(page, ["e2e-dev-a", "e2e-dev-b"]);

    const markA = calls.length;
    await versionPillReset(page).click();
    await page.waitForLoadState("networkidle");
    await expectDevices(page, ALL_DEVICES);
    await expectNoVersionedCallsAfter(calls, markA);
    await expect(page.getByRole("button", { name: /^Version is/ })).toHaveCount(0);
    await page.screenshot({ path: "artifacts/at6-01-cleared.png" });

    // --- toolbar Reset All ---
    await openVersionFilter(page);
    await chooseVersion(page, V_OLD);
    await page.keyboard.press("Escape");
    await page.waitForLoadState("networkidle");
    await expectDevices(page, ["e2e-dev-d"]);

    const markB = calls.length;
    await page.getByRole("button", { name: "Reset All" }).click();
    await page.waitForLoadState("networkidle");
    await expectDevices(page, ALL_DEVICES);
    await expectNoVersionedCallsAfter(calls, markB);
    await expect(page.getByRole("button", { name: /^Version is/ })).toHaveCount(0);
    await page.screenshot({ path: "artifacts/at6-02-reset-all.png" });
  });

  test("at7 — the synthetic Unknown row stays in sync with the searched (debounced) options", async ({ page }) => {
    await openPage(page, "/integrations/scanner");
    const search = await openVersionFilter(page);

    // "3.0" matches no part of "Unknown": once the debounced search has settled, the
    // Unknown row is gone and only the matching API version remains.
    await search.fill("3.0");
    await expect(page.getByRole("option", { name: V_HOST, exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Unknown", exact: true })).toHaveCount(0);
    await page.screenshot({ path: "artifacts/at7-01-search-3.0.png" });

    // "unk" matches the Unknown row and no API version.
    await search.fill("unk");
    await expect(page.getByRole("option", { name: "Unknown", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: V_HOST, exact: true })).toHaveCount(0);
    await page.screenshot({ path: "artifacts/at7-02-search-unk.png" });

    // Clearing the search restores the full option set.
    await search.fill("");
    await expect(page.getByRole("option", { name: "Unknown", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: V_HOST, exact: true })).toBeVisible();
  });

  test("at8 — the Unknown row never disappears before the debounced facet request goes out", async ({ page }) => {
    // The regression this pins: keying the Unknown row off the immediate `search` value made it
    // vanish up to a full debounce interval (400ms) before the API rows beside it changed.
    let facetSearchAt: number | null = null;
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (!url.pathname.endsWith("/scanner-installations/versions")) return;
      if (url.searchParams.get("search") === "3.0" && facetSearchAt === null) facetSearchAt = Date.now();
    });

    await openPage(page, "/integrations/scanner");
    const search = await openVersionFilter(page);
    await expect(page.getByRole("option", { name: "Unknown", exact: true })).toBeVisible();

    const unknown = page.getByRole("option", { name: "Unknown", exact: true });
    const typedAt = Date.now();
    await search.fill("3.0");

    // Sample until the Unknown row goes away, and snapshot whether the debounced facet
    // request had already gone out at that exact moment.
    let unknownGoneAt: number | null = null;
    let facetSentWhenRowVanished: number | null = null;
    while (Date.now() - typedAt < 5_000) {
      if ((await unknown.count()) === 0) {
        unknownGoneAt = Date.now();
        facetSentWhenRowVanished = facetSearchAt;
        break;
      }
      await page.waitForTimeout(20);
    }

    expect(unknownGoneAt, "the Unknown row should eventually be filtered out by the search").not.toBeNull();
    await expect.poll(() => facetSearchAt, { timeout: 5_000 }).not.toBeNull();

    // Pre-fix this is null: the row vanished on the keystroke, a whole debounce interval
    // before the request that updates the API rows beside it.
    expect(
      facetSentWhenRowVanished,
      `the Unknown row vanished ${(facetSearchAt as unknown as number) - (unknownGoneAt as number)}ms BEFORE the debounced facet request`
    ).not.toBeNull();
  });
});
