// LaunchLens — the token-radar-01 value model.
//
// One snapshot of the DeFi protocol universe in, one ranked board of pre-token protocols out, plus a
// costed farm plan for each. The guiding idea that separates this radar from a flat TVL multiple:
//
//   The market already prices tokens. The snapshot carries ~120 protocols whose token trades, each with
//   a market cap AND a TVL. Their mcap / TVL ratio, read per category, is what the market pays for a
//   dollar of TVL in that sector right now. So instead of guessing one multiple for everything, this
//   model LEARNS a valuation multiple from the snapshot's own live protocols and applies the category's
//   observed multiple to each pre-token protocol's TVL. No protocol name is ever special-cased; the same
//   function scores every row, and every constant is derived from the snapshot or stated in the page.
//
// implied_value = tvl
//               x sectorMultiple(category)        // learned from live protocols of the same category
//               x momentum(change_7d)             // 7-day TVL growth, bounded
//               x timing(age_days)                // longer with no token => a larger expected allocation
//               x conviction(tvl, age, category)  // how much we trust the estimate, 0.7..1.0
//
// The board separates pre-token protocols (ranked by implied value) from live-token ones (shown at the
// market's own value, never mixed into the ranking).

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

const DAY_MS = 86_400_000;

/** Model tuning, all stated on the dashboard so a reader can audit the valuation. */
export const MODEL = {
  version: 'launchlens-2',
  // Momentum: 7-day TVL change in %, clamped, scaled. Growth is a signal, not the whole story.
  momentum_floor_pct: -50,
  momentum_cap_pct: 150,
  momentum_weight: 0.6,
  // Timing: a protocol that has run longer with no token has accrued more unrewarded usage, so a token
  // (if it comes) tends to carry a larger retroactive allocation. Bounded 0.8..1.35 over 0..2 years.
  timing_floor: 0.8,
  timing_peak: 1.35,
  timing_days: 730,
  timing_unknown_days: 240,
  // Sector multiple bounds: a learned mcap/TVL ratio is clamped here so one outlier cannot dominate.
  sector_multiple_floor: 0.05,
  sector_multiple_cap: 2.0,
  // Fallback multiple when a category has too few live comparables (uses the global median at runtime).
  sector_min_comparables: 3,
  // Conviction: estimates on larger, older, well-populated sectors are trusted more.
  conviction_floor: 0.7,
};

/** A whole-day age from listed_at to as_of, or null when the date is missing/bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release (" V2", " 2.0") is a pool of another protocol. */
const VERSIONED = /\s(v\d+(\.\d+)?|\d+\.\d+)$/i;

/** No token recorded at all: the subject the radar ranks. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A protocol the board may rank: pre-token, not an exchange desk, not a versioned sub-pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The median of a numeric array (sorted copy); 0 for an empty one. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** A learned table of mcap/TVL multiples, one per category plus a global fallback, from live protocols. */
export interface SectorTable {
  global: number;
  byCategory: Record<string, { multiple: number; comparables: number }>;
}

/**
 * Learn the valuation multiple from the snapshot's own live-token protocols: for each category, the
 * median of (market cap / TVL) over its live protocols; globally, the same over all of them. This is the
 * market's current price for a dollar of TVL, read from the data, never hardcoded.
 */
export function learnSectors(snapshot: Snapshot): SectorTable {
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.tvl_usd > 0 && p.category !== 'CEX');
  const globalMed = clamp(median(live.map((p) => p.mcap_usd! / p.tvl_usd)) || 0.24, MODEL.sector_multiple_floor, MODEL.sector_multiple_cap);
  const groups = new Map<string, number[]>();
  for (const p of live) {
    if (p.category === null) continue;
    (groups.get(p.category) ?? groups.set(p.category, []).get(p.category)!).push(p.mcap_usd! / p.tvl_usd);
  }
  const byCategory: Record<string, { multiple: number; comparables: number }> = {};
  for (const [cat, ratios] of groups) {
    byCategory[cat] = {
      multiple: clamp(median(ratios), MODEL.sector_multiple_floor, MODEL.sector_multiple_cap),
      comparables: ratios.length,
    };
  }
  return { global: globalMed, byCategory };
}

/** The multiple one protocol's category earns: its learned median if it has enough comparables, else global. */
export function sectorMultiple(p: SnapshotProtocol, sectors: SectorTable): { multiple: number; comparables: number; source: 'category' | 'global' } {
  const cat = p.category;
  if (cat !== null) {
    const row = sectors.byCategory[cat];
    if (row !== undefined && row.comparables >= MODEL.sector_min_comparables) {
      return { multiple: row.multiple, comparables: row.comparables, source: 'category' };
    }
  }
  return { multiple: sectors.global, comparables: 0, source: 'global' };
}

/** Momentum factor from 7-day TVL change; 1.0 when flat or unreported. */
export function momentum(change7d: number | null): number {
  const g = clamp(typeof change7d === 'number' && Number.isFinite(change7d) ? change7d : 0, MODEL.momentum_floor_pct, MODEL.momentum_cap_pct);
  return 1 + (g / 100) * MODEL.momentum_weight;
}

/** Timing factor: rises with how long a protocol has run with no token (bounded). */
export function timing(age: number | null): number {
  const d = clamp(age ?? MODEL.timing_unknown_days, 0, MODEL.timing_days);
  return MODEL.timing_floor + (d / MODEL.timing_days) * (MODEL.timing_peak - MODEL.timing_floor);
}

/** Conviction 0.7..1.0: higher for larger TVL, a known age, and a category with real comparables. */
export function conviction(p: SnapshotProtocol, age: number | null, cmp: { comparables: number }): number {
  let c = MODEL.conviction_floor;
  if (p.tvl_usd >= 50_000_000) c += 0.12;
  else if (p.tvl_usd >= 20_000_000) c += 0.07;
  else if (p.tvl_usd >= 10_000_000) c += 0.03;
  if (age !== null) c += 0.08;
  if (cmp.comparables >= MODEL.sector_min_comparables) c += 0.1;
  return clamp(Math.round(c * 100) / 100, MODEL.conviction_floor, 1.0);
}

/** Airdrop-likelihood read (Low/Medium/High), from age and growth — shown on the board and detail view. */
export function airdropOdds(age: number | null, change7d: number | null): 'Low' | 'Medium' | 'High' {
  const g = typeof change7d === 'number' ? change7d : 0;
  const a = age ?? 0;
  let s = 0;
  if (a >= 365) s += 2; else if (a >= 180) s += 1;
  if (g >= 20) s += 2; else if (g >= 0) s += 1;
  return s >= 3 ? 'High' : s >= 2 ? 'Medium' : 'Low';
}

export interface Valuation {
  implied: number;
  sector_multiple: number;
  sector_source: 'category' | 'global';
  comparables: number;
  momentum: number;
  timing: number;
  conviction: number;
  age: number | null;
}

/** The full valuation of one protocol under the learned sector table. */
export function value(p: SnapshotProtocol, asOf: string, sectors: SectorTable): Valuation {
  const age = ageDays(asOf, p.listed_at);
  const sm = sectorMultiple(p, sectors);
  const mom = momentum(p.change_7d);
  const tim = timing(age);
  const conv = conviction(p, age, sm);
  const implied = Math.max(1, Math.round(p.tvl_usd * sm.multiple * mom * tim * conv));
  return {
    implied,
    sector_multiple: Math.round(sm.multiple * 1e4) / 1e4,
    sector_source: sm.source,
    comparables: sm.comparables,
    momentum: Math.round(mom * 1e4) / 1e4,
    timing: Math.round(tim * 1e4) / 1e4,
    conviction: conv,
    age,
  };
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  airdrop_odds: 'Low' | 'Medium' | 'High';
  on_watchlist: boolean;
  model: {
    sector_multiple: number;
    sector_source: 'category' | 'global';
    comparables: number;
    momentum: number;
    timing: number;
    conviction: number;
  };
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_to_tvl: number | null;
}

/** How many pre-token protocols below the floor the early radar adds, by TVL. */
export const EARLY_ROWS = 170;
/** How many live-token protocols the comparables view shows. */
export const LIVE_ROWS = 28;

/** Capital for one farm position, scaled to the protocol's size. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 200_000_000) return 120;
  if (p.tvl_usd >= 50_000_000) return 80;
  return 50;
}

/** Hold window from age: a younger protocol needs a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 120) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The first chain the protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's core farming action, in words a reader can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC into ${n} on ${chain}, then borrow a small amount against it to count as an active borrower.`;
  if (c.includes('dex') || c.includes('dexs')) return `Provide $${capital} of liquidity to a ${n} pool on ${chain} and make at least one swap through the protocol each week.`;
  if (c.includes('yield') || c.includes('farm')) return `Deposit $${capital} into a ${n} vault on ${chain} and let it compound; re-deposit once after the first week.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${n} and then use the bridged funds in at least one onward transaction.`;
  if (c.includes('stak') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${n} on ${chain} and keep the liquid receipt token in the same wallet.`;
  if (c.includes('perp') || c.includes('deriv') || c.includes('basis')) return `Deposit $${capital} of USDC as margin on ${n} and open one small, hedged position to log real volume.`;
  if (c.includes('predict')) return `Fund $${capital} and take one position in an active ${n} market on ${chain}, then settle it.`;
  if (c.includes('curat') || c.includes('allocat') || c.includes('vault')) return `Deposit $${capital} into a curated ${n} vault on ${chain} and hold the vault shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of ${n}'s stable asset on ${chain} and use it in one more protocol to show composability.`;
  if (c.includes('rwa') || c.includes('real world')) return `Mint $${capital} of ${n}'s yield-bearing asset on ${chain} and hold it through a full accrual period.`;
  if (c.includes('insur')) return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy active.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open with one action a week.`;
}

/**
 * A protocol's farm plan: five concrete steps, each with a cost and a time, derived from the protocol's
 * own record (category, chain, TVL, age) — never a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, odds: 'Low' | 'Medium' | 'High'): string[] {
  const chain = chainOf(p);
  const cap = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = cap >= 120 ? 10 : 5;
  const steps = [
    `Set up a fresh wallet used only for this farm and fund it on ${chain}; keep its seed phrase offline and label it in your tracker. Cost: about $${gas} of gas plus the capital you move in. Time: about 10 minutes.`,
    `${actionFor(p, cap, chain)} Cost: $${cap} of capital and roughly $${gas} of gas. Time: about 15 minutes to open.`,
    `Keep one qualifying on-chain action each week — a deposit, borrow, swap, or governance vote — so your wallet appears in several activity snapshots, not just one. Cost: about $2-4 of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days (airdrop likelihood here reads ${odds}), since retroactive rewards weight sustained, repeat usage far above a single touch. Cost: the $${cap} stays locked in the position. Time: ${hold} days.`,
    `Before unwinding, open ${p.name}'s own points or rewards page, claim only from the link it publishes, and record every wallet, date, and transaction so the position can be repeated or unwound cleanly. Cost: no fee to check — never pay a third party to "claim". Time: about 15 minutes.`,
  ];
  // Guard the gate's 20..600 char bounds on every step.
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s.length < 20 ? `${s} Keep the position open and monitor the protocol's official channels.` : s));
}

/** Compact row for the dashboard's data.js. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  airdrop_odds: 'Low' | 'Medium' | 'High';
  on_watchlist: boolean;
  sector_multiple: number;
  sector_source: 'category' | 'global';
  momentum: number;
  timing: number;
  conviction: number;
  farm_steps: string[];
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model_note: string;
  sectors: { category: string; multiple: number; comparables: number }[];
  global_multiple: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The protocols the board ranks, strongest first, ranks 1..n: the watchlist plus the biggest early finds. */
export function buildBoard(snapshot: Snapshot, sectors: SectorTable): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, v: value(p, snapshot.as_of, sectors) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  return scored.map((s, i) => {
    const odds = airdropOdds(s.v.age, s.p.change_7d);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token' as const,
      age_days: s.v.age,
      implied_value_usd: s.v.implied,
      airdrop_odds: odds,
      on_watchlist: watch.has(s.p.slug),
      model: {
        sector_multiple: s.v.sector_multiple,
        sector_source: s.v.sector_source,
        comparables: s.v.comparables,
        momentum: s.v.momentum,
        timing: s.v.timing,
        conviction: s.v.conviction,
      },
      farm_steps: farmSteps(s.p, s.v.age, odds),
    };
  });
}

/** Live-token protocols, by market cap, for the comparables view that grounds the model. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_to_tvl: p.tvl_usd > 0 && p.mcap_usd !== null ? Math.round((p.mcap_usd / p.tvl_usd) * 100) / 100 : null,
    }));
}

/** Everything the dashboard renders. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const sectors = learnSectors(snapshot);
  const board = buildBoard(snapshot, sectors);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.on_watchlist).length;
  const sectorList = Object.entries(sectors.byCategory)
    .filter(([, v]) => v.comparables >= MODEL.sector_min_comparables)
    .map(([category, v]) => ({ category, multiple: v.multiple, comparables: v.comparables }))
    .sort((a, b) => b.comparables - a.comparables);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL.version,
    model_note:
      'Implied value = TVL x a sector multiple learned from the snapshot\'s own live-token protocols (median market-cap / TVL per category) x 7-day momentum x token-timing x conviction. No protocol is special-cased.',
    sectors: sectorList,
    global_multiple: Math.round(sectors.global * 1e4) / 1e4,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      airdrop_odds: r.airdrop_odds,
      on_watchlist: r.on_watchlist,
      sector_multiple: r.model.sector_multiple,
      sector_source: r.model.sector_source,
      momentum: r.model.momentum,
      timing: r.model.timing,
      conviction: r.model.conviction,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** Parse the snapshot, refusing anything that is not the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug(s): ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board has ${board.length} rows, under the 100 the gate needs`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return `all rows share one implied value`;
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
