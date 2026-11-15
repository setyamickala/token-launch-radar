// LaunchLens v3 — a comps-calibrated token launch radar model.
//
// The core idea: the snapshot already contains ~120 protocols whose token trades, each with a market cap
// AND a TVL. Those live protocols are the market's own revealed pricing of a dollar of TVL. This model
// learns a valuation from them in three calibrated layers, then prices every pre-token protocol:
//
//   1. Dedup live protocols into FAMILIES (a protocol and its v2/AMM/CLMM/staked pools are one token), so
//      a multi-pool token is counted once, not many times.
//   2. SECTOR multiple: per-category median market-cap/TVL, Empirical-Bayes shrunk in log space toward the
//      global median (thin categories are pulled to the prior; deep ones keep their own signal).
//   3. SIZE curve: a log-log power law mcap ~ alpha + beta*log(TVL) fit over the families (robust, trimmed),
//      because bigger protocols tend to carry a lower mcap/TVL multiple.
//
//   implied_value(p) = round( p.tvl_usd
//                           × blendedMultiple(p)   // shrunk sector^0.65 ⊕ size-curve^0.35
//                           × momentum(change_7d)  // 1 + clamp(change_7d,-50%,+150%)/100 × 0.55
//                           × timing(age_days)     // 0.82..1.34 over 0..730 tokenless operating days
//                           × conviction(p) )      // 0.72..1.00 from TVL depth, verified age, chain breadth
//
// The model is validated out-of-sample by Leave-One-Out Cross-Validation (LOO-CV) over the live families:
// drop each family, refit, predict its mcap, and report the median error, the share within 2x/3x, and the
// Spearman rank correlation. No protocol is ever special-cased by name.

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

export const MODEL = {
  version: 'launchlens-3',
  momentum_floor_pct: -50,
  momentum_cap_pct: 150,
  momentum_weight: 0.55,
  timing_floor: 0.82,
  timing_peak: 1.34,
  timing_days: 730,
  timing_unknown_days: 240,
  sector_floor: 0.05,
  sector_cap: 2.2,
  sector_blend_w: 0.65, // weight on the shrunk sector multiple vs the size-curve multiple
  shrink_prior_k: 4, // Empirical-Bayes prior strength (categories with n comparables get weight n/(n+k))
  conviction_floor: 0.72,
  early_rows: 175,
  live_display_rows: 40,
};

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const r2 = (x: number): number => Math.round(x * 100) / 100;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

// A family stem collapses a protocol and its versioned/pool siblings to one token identity.
const NAME_SUFFIX = /\s+(v\d+(\.\d+)?|\d+\.\d+|amm|clmm|dex|lend(ing)?|earn|vaults?|bridge|staked\s+\w+)$/i;
const SLUG_SUFFIX = /-(v\d+|amm|clmm|dex|lend(ing)?|earn|vaults?)$/i;
export function familyStem(slug: string, name: string): string {
  const cn = name.toLowerCase().replace(NAME_SUFFIX, '').trim().replace(/[^a-z0-9]+/g, '-');
  const bs = slug.toLowerCase().replace(SLUG_SUFFIX, '');
  return cn || bs;
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(v\d+(\.\d+)?|\d+\.\d+)$/i;
const SLUG_VERSIONED = /-(v\d+)$/i;
export function isRankable(p: SnapshotProtocol, liveStems?: Set<string>): boolean {
  if (!isPreToken(p) || p.category === 'CEX' || p.tvl_usd <= 0) return false;
  if (VERSIONED.test(p.name) || SLUG_VERSIONED.test(p.slug)) return false;
  if (liveStems !== undefined && liveStems.has(familyStem(p.slug, p.name))) return false;
  return true;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[Math.min(sorted.length - 1, base + 1)]!;
  return sorted[base]! + rest * (next - sorted[base]!);
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  return quantile([...xs].sort((a, b) => a - b), 0.5);
}

// ---- Live families (deduplicated live-token protocols) ----
export interface LiveFamily {
  family_id: string;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  ratio: number;
  sub_protocols: number;
}

export function buildLiveFamilies(snapshot: Snapshot): LiveFamily[] {
  const live = snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX',
  );
  const groups = new Map<string, SnapshotProtocol[]>();
  for (const p of live) {
    const key = (p.gecko_id ?? p.symbol ?? familyStem(p.slug, p.name)).toLowerCase();
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  }
  const fams: LiveFamily[] = [];
  for (const [key, members] of groups) {
    members.sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
    const primary = members[0]!;
    const totalTvl = members.reduce((s, m) => s + m.tvl_usd, 0);
    const maxMcap = Math.max(...members.map((m) => m.mcap_usd ?? 0));
    if (totalTvl <= 0 || maxMcap <= 0) continue;
    const chains = new Set<string>();
    for (const m of members) for (const c of m.chains) chains.add(c);
    fams.push({
      family_id: key,
      slug: primary.slug,
      name: primary.name,
      category: primary.category,
      chains: [...chains],
      tvl_usd: totalTvl,
      mcap_usd: maxMcap,
      change_7d: primary.change_7d,
      ratio: clamp(maxMcap / totalTvl, MODEL.sector_floor, MODEL.sector_cap),
      sub_protocols: members.length,
    });
  }
  return fams.sort((a, b) => b.mcap_usd - a.mcap_usd || b.tvl_usd - a.tvl_usd);
}

// ---- Power-law size curve: mcap = 10^(alpha + beta*log10 TVL), robust-trimmed OLS in log space ----
export interface PowerLawCurve {
  alpha: number;
  beta: number;
  ref_tvl_usd: number;
  p25_mult: number;
  p75_mult: number;
}

export function fitPowerLaw(families: LiveFamily[]): PowerLawCurve {
  if (families.length < 4) return { alpha: 0.95, beta: 0.78, ref_tvl_usd: 50_000_000, p25_mult: 0.62, p75_mult: 1.58 };
  const byRatio = [...families].sort((a, b) => a.ratio - b.ratio);
  const lo = Math.floor(byRatio.length * 0.05);
  const hi = Math.max(lo + 2, Math.ceil(byRatio.length * 0.95));
  const t = byRatio.slice(lo, hi);
  const xs = t.map((f) => Math.log10(Math.max(f.tvl_usd, 1e4)));
  const ys = t.map((f) => Math.log10(Math.max(f.mcap_usd, 1e3)));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    num += dx * (ys[i]! - my);
    den += dx * dx;
  }
  const beta = clamp(den > 1e-9 ? num / den : 0.78, 0.55, 0.92);
  const alpha = my - beta * mx;
  const resid = t
    .map((f) => f.mcap_usd / Math.max(1, Math.pow(10, alpha + beta * Math.log10(Math.max(f.tvl_usd, 1e4)))))
    .sort((a, b) => a - b);
  return {
    alpha: r4(alpha),
    beta: r4(beta),
    ref_tvl_usd: 50_000_000,
    p25_mult: r2(clamp(quantile(resid, 0.25) || 0.62, 0.45, 0.85)),
    p75_mult: r2(clamp(quantile(resid, 0.75) || 1.58, 1.2, 2.25)),
  };
}

export function sizeCurveMultiple(tvlUsd: number, c: PowerLawCurve): number {
  const tvl = Math.max(tvlUsd, 50_000);
  return clamp(Math.pow(10, c.alpha + c.beta * Math.log10(tvl)) / tvl, MODEL.sector_floor, MODEL.sector_cap);
}

// ---- Sector table with Empirical-Bayes shrinkage ----
export interface SectorEntry {
  raw_multiple: number;
  multiple: number;
  comparables: number;
  shrinkage_weight: number;
  p25_ratio: number;
  p75_ratio: number;
}
export interface SectorTable {
  global: number;
  global_p25: number;
  global_p75: number;
  curve: PowerLawCurve;
  byCategory: Record<string, SectorEntry>;
  live_families_count: number;
}

export function learnSectorsFromFamilies(families: LiveFamily[]): SectorTable {
  const ratios = families.map((f) => f.ratio).sort((a, b) => a - b);
  const g = clamp(median(ratios) || 0.1857, MODEL.sector_floor, MODEL.sector_cap);
  const gP25 = clamp(quantile(ratios, 0.25) || g * 0.6, MODEL.sector_floor, MODEL.sector_cap);
  const gP75 = clamp(quantile(ratios, 0.75) || g * 1.6, MODEL.sector_floor, MODEL.sector_cap);
  const curve = fitPowerLaw(families);
  const groups = new Map<string, number[]>();
  for (const f of families) {
    if (f.category === null) continue;
    (groups.get(f.category) ?? groups.set(f.category, []).get(f.category)!).push(f.ratio);
  }
  const byCategory: Record<string, SectorEntry> = {};
  const k = MODEL.shrink_prior_k;
  for (const [cat, rs] of groups) {
    const sorted = [...rs].sort((a, b) => a - b);
    const rawMed = clamp(median(sorted), MODEL.sector_floor, MODEL.sector_cap);
    const n = sorted.length;
    const w = n / (n + k);
    const shrunk = clamp(Math.exp(w * Math.log(rawMed) + (1 - w) * Math.log(g)), MODEL.sector_floor, MODEL.sector_cap);
    byCategory[cat] = {
      raw_multiple: r4(rawMed),
      multiple: r4(shrunk),
      comparables: n,
      shrinkage_weight: r2(w),
      p25_ratio: r4(clamp(quantile(sorted, 0.25) || shrunk * 0.65, MODEL.sector_floor, MODEL.sector_cap)),
      p75_ratio: r4(clamp(quantile(sorted, 0.75) || shrunk * 1.55, MODEL.sector_floor, MODEL.sector_cap)),
    };
  }
  return { global: r4(g), global_p25: r4(gP25), global_p75: r4(gP75), curve, byCategory, live_families_count: families.length };
}

export function learnSectors(snapshot: Snapshot): SectorTable {
  return learnSectorsFromFamilies(buildLiveFamilies(snapshot));
}

export function blendedMultiple(
  p: { category: string | null; tvl_usd: number },
  sectors: SectorTable,
): { multiple: number; raw_multiple: number; size_multiple: number; sector_multiple: number; comparables: number; shrinkage_weight: number; source: 'category' | 'global'; p25_mult: number; p75_mult: number } {
  const size = sizeCurveMultiple(p.tvl_usd, sectors.curve);
  const cat = p.category;
  const entry = cat !== null ? sectors.byCategory[cat] : undefined;
  const hasCat = entry !== undefined && entry.comparables >= 3;
  const sectorMult = hasCat ? entry!.multiple : sectors.global;
  const rawMult = hasCat ? entry!.raw_multiple : sectors.global;
  const w = MODEL.sector_blend_w;
  // geometric blend of the shrunk sector multiple and the size-curve multiple
  const blended = clamp(Math.exp(w * Math.log(sectorMult) + (1 - w) * Math.log(size)), MODEL.sector_floor, MODEL.sector_cap);
  const p25 = hasCat ? entry!.p25_ratio : sectors.global_p25;
  const p75 = hasCat ? entry!.p75_ratio : sectors.global_p75;
  return {
    multiple: r4(blended),
    raw_multiple: rawMult,
    size_multiple: r4(size),
    sector_multiple: r4(sectorMult),
    comparables: hasCat ? entry!.comparables : 0,
    shrinkage_weight: hasCat ? entry!.shrinkage_weight : 0,
    source: hasCat ? 'category' : 'global',
    p25_mult: r4(clamp(blended * (p25 / Math.max(1e-6, rawMult)), MODEL.sector_floor, MODEL.sector_cap)),
    p75_mult: r4(clamp(blended * (p75 / Math.max(1e-6, rawMult)), MODEL.sector_floor, MODEL.sector_cap)),
  };
}

export function momentum(change7d: number | null): number {
  const g = clamp(typeof change7d === 'number' && Number.isFinite(change7d) ? change7d : 0, MODEL.momentum_floor_pct, MODEL.momentum_cap_pct);
  return 1 + (g / 100) * MODEL.momentum_weight;
}
export function timing(age: number | null): number {
  const d = clamp(age ?? MODEL.timing_unknown_days, 0, MODEL.timing_days);
  return MODEL.timing_floor + (d / MODEL.timing_days) * (MODEL.timing_peak - MODEL.timing_floor);
}
export function conviction(p: SnapshotProtocol, age: number | null, comparables: number): number {
  let c = MODEL.conviction_floor;
  if (p.tvl_usd >= 100_000_000) c += 0.13;
  else if (p.tvl_usd >= 30_000_000) c += 0.08;
  else if (p.tvl_usd >= 10_000_000) c += 0.04;
  if (age !== null) c += 0.07;
  if ((p.chains?.length ?? 0) >= 3) c += 0.04;
  if (comparables >= 3) c += 0.04;
  return clamp(r2(c), MODEL.conviction_floor, 1.0);
}
export function airdropOdds(age: number | null, change7d: number | null, onWatchlist?: boolean): 'Low' | 'Medium' | 'High' {
  const g = typeof change7d === 'number' ? change7d : 0;
  const a = age ?? 0;
  let s = 0;
  if (a >= 365) s += 2;
  else if (a >= 180) s += 1;
  if (g >= 20) s += 2;
  else if (g >= 0) s += 1;
  if (onWatchlist) s += 1;
  return s >= 4 ? 'High' : s >= 2 ? 'Medium' : 'Low';
}
export function confidenceGrade(age: number | null, comparables: number, tvlUsd: number): 'A' | 'B' | 'C' {
  let s = 0;
  if (comparables >= 5) s += 2;
  else if (comparables >= 3) s += 1;
  if (age !== null) s += 1;
  if (tvlUsd >= 50_000_000) s += 1;
  return s >= 3 ? 'A' : s >= 2 ? 'B' : 'C';
}
export function farmVerdict(odds: 'Low' | 'Medium' | 'High', impliedUsd: number, onWatchlist: boolean): 'Priority Farm' | 'Active Farm' | 'Selective' | 'Monitor' {
  if (odds === 'High' && impliedUsd >= 30_000_000) return 'Priority Farm';
  if (odds === 'High' || (odds === 'Medium' && onWatchlist)) return 'Active Farm';
  if (odds === 'Medium') return 'Selective';
  return 'Monitor';
}

export interface Valuation {
  implied: number;
  p25: number;
  p75: number;
  multiple: number;
  size_multiple: number;
  sector_multiple: number;
  comparables: number;
  shrinkage_weight: number;
  source: 'category' | 'global';
  momentum: number;
  timing: number;
  conviction: number;
  age: number | null;
}
export function value(p: SnapshotProtocol, asOf: string, sectors: SectorTable): Valuation {
  const age = ageDays(asOf, p.listed_at);
  const bm = blendedMultiple(p, sectors);
  const mom = momentum(p.change_7d);
  const tim = timing(age);
  const conv = conviction(p, age, bm.comparables);
  const factor = mom * tim * conv;
  return {
    implied: Math.max(1, Math.round(p.tvl_usd * bm.multiple * factor)),
    p25: Math.max(1, Math.round(p.tvl_usd * bm.p25_mult * factor)),
    p75: Math.max(1, Math.round(p.tvl_usd * bm.p75_mult * factor)),
    multiple: bm.multiple,
    size_multiple: bm.size_multiple,
    sector_multiple: bm.sector_multiple,
    comparables: bm.comparables,
    shrinkage_weight: bm.shrinkage_weight,
    source: bm.source,
    momentum: r4(mom),
    timing: r4(tim),
    conviction: conv,
    age,
  };
}

// ---- Leave-One-Out Cross-Validation over the live families ----
export interface BacktestStats {
  n: number;
  median_abs_log_err: number;
  within_2x_pct: number;
  within_3x_pct: number;
  spearman: number;
  median_ratio_err: number;
}
function spearman(xs: number[], ys: number[]): number {
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length).fill(0);
    for (let i = 0; i < idx.length; i++) r[idx[i]![1]] = i + 1;
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  if (n < 2) return 0;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i]! - mx;
    const b = ry[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? r4(num / Math.sqrt(dx * dy)) : 0;
}
export function runBacktest(families: LiveFamily[]): BacktestStats {
  if (families.length < 6) return { n: families.length, median_abs_log_err: 0, within_2x_pct: 0, within_3x_pct: 0, spearman: 0, median_ratio_err: 0 };
  const actual: number[] = [];
  const pred: number[] = [];
  const logErr: number[] = [];
  const ratioErr: number[] = [];
  for (let i = 0; i < families.length; i++) {
    const held = families[i]!;
    const rest = families.filter((_, j) => j !== i);
    const st = learnSectorsFromFamilies(rest);
    const bm = blendedMultiple({ category: held.category, tvl_usd: held.tvl_usd }, st);
    const predMcap = Math.max(1, held.tvl_usd * bm.multiple);
    actual.push(held.mcap_usd);
    pred.push(predMcap);
    logErr.push(Math.abs(Math.log10(predMcap / held.mcap_usd)));
    ratioErr.push(Math.max(predMcap, held.mcap_usd) / Math.min(predMcap, held.mcap_usd));
  }
  const within = (f: number): number => Math.round((ratioErr.filter((e) => e <= f).length / ratioErr.length) * 1000) / 10;
  return {
    n: families.length,
    median_abs_log_err: r4(median(logErr)),
    within_2x_pct: within(2),
    within_3x_pct: within(3),
    spearman: spearman(actual, pred),
    median_ratio_err: r2(median(ratioErr)),
  };
}

// ---- Farm economics and plans ----
export interface FarmEconomics {
  capital: number;
  gas: number;
  hold_days: number;
}
export function farmEconomicsFor(p: SnapshotProtocol, age: number | null): FarmEconomics {
  const capital = p.tvl_usd >= 1_000_000_000 ? 200 : p.tvl_usd >= 200_000_000 ? 120 : p.tvl_usd >= 50_000_000 ? 80 : 50;
  const gas = (p.chains[0] ?? '').toLowerCase().includes('ethereum') ? 12 : 5;
  const hold = age === null ? 45 : age < 120 ? 60 : age < 365 ? 45 : 30;
  return { capital, gas, hold_days: hold };
}
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}
function actionFor(p: SnapshotProtocol, cap: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${cap} of USDC into ${n} on ${chain}, then borrow a small amount against it to register as an active borrower, not just a depositor.`;
  if (c.includes('dex')) return `Provide $${cap} of liquidity to a ${n} pool on ${chain} and route at least one swap through the protocol each week to log real volume.`;
  if (c.includes('yield') || c.includes('farm')) return `Deposit $${cap} into a ${n} vault on ${chain}, let it compound, and re-deposit once after the first week to show repeat usage.`;
  if (c.includes('bridge')) return `Bridge $${cap} of USDC to ${chain} through ${n}, then use the bridged funds in at least one onward transaction so the bridge sees a real round trip.`;
  if (c.includes('stak') || c.includes('restak')) return `Stake $${cap} of the chain's staking asset through ${n} on ${chain} and keep the liquid receipt token in the same wallet.`;
  if (c.includes('perp') || c.includes('deriv') || c.includes('basis')) return `Deposit $${cap} of USDC as margin on ${n} and open one small, fully hedged position to log genuine volume without directional risk.`;
  if (c.includes('curat') || c.includes('allocat') || c.includes('vault')) return `Deposit $${cap} into a curated ${n} vault on ${chain} and hold the vault shares through a full rebalance.`;
  if (c.includes('stable')) return `Mint or deposit $${cap} of ${n}'s stable asset on ${chain} and use it in one more protocol to show composable demand.`;
  if (c.includes('rwa') || c.includes('real world')) return `Mint $${cap} of ${n}'s yield-bearing asset on ${chain} and hold it through a full accrual period.`;
  return `Deposit $${cap} of USDC into ${n} on ${chain} and keep the position open with one qualifying action a week.`;
}
export function farmSteps(p: SnapshotProtocol, age: number | null, odds: 'Low' | 'Medium' | 'High'): string[] {
  const chain = chainOf(p);
  const e = farmEconomicsFor(p, age);
  const steps = [
    `Set up a fresh wallet used only for this farm and fund it on ${chain}; keep its seed phrase offline and label it in your tracker so this position never mixes with others. Cost: about $${e.gas} of gas plus the capital you move in. Time: about 10 minutes.`,
    `${actionFor(p, e.capital, chain)} Cost: $${e.capital} of capital and roughly $${e.gas} of gas. Time: about 15 minutes to open.`,
    `Keep one qualifying on-chain action each week — a deposit, borrow, swap, or governance vote — so your wallet appears across several activity snapshots, which retroactive allocations weight far above a single touch. Cost: about $2-4 of gas a week. Time: 10 minutes a week.`,
    `Hold the position at least ${e.hold_days} days (airdrop likelihood reads ${odds} here from age and growth), since sustained, repeat usage is what unrewarded-usage allocations reward. Cost: the $${e.capital} stays in the position. Time: ${e.hold_days} days.`,
    `Before unwinding, open ${p.name}'s own points or rewards page, claim only from the link it publishes, and log every wallet, date, and transaction so the position can be repeated or cleanly exited. Cost: no fee to check — never pay a third party to "claim". Time: about 15 minutes.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s.length < 20 ? `${s} Keep the position open and monitor official channels.` : s));
}

// ---- Board, live rows, audit, radar ----
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
  implied_p25_usd: number;
  implied_p75_usd: number;
  airdrop_odds: 'Low' | 'Medium' | 'High';
  confidence: 'A' | 'B' | 'C';
  verdict: 'Priority Farm' | 'Active Farm' | 'Selective' | 'Monitor';
  on_watchlist: boolean;
  model: { multiple: number; sector_multiple: number; size_multiple: number; comparables: number; shrinkage_weight: number; source: 'category' | 'global'; momentum: number; timing: number; conviction: number };
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
  pred_mcap_usd: number;
  sub_protocols: number;
}
export interface AuditEntry { slug: string; name: string; category: string | null; tvl_usd: number; reason: string }
export interface AuditSummary { total_protocols: number; live_token: number; live_families: number; pre_token: number; watchlist: number; ranked: number; excluded: number }
export interface RadarRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; listed_at: string | null; age_days: number | null;
  implied_value_usd: number; implied_p25_usd: number; implied_p75_usd: number;
  airdrop_odds: string; confidence: string; verdict: string; on_watchlist: boolean;
  multiple: number; sector_multiple: number; size_multiple: number; momentum: number; timing: number; conviction: number; comparables: number; source: string;
  farm_steps: string[];
}
export interface RadarData {
  as_of: string; source: string; floor_usd: number; model_version: string; model_note: string;
  sectors: { category: string; multiple: number; raw: number; comparables: number; p25: number; p75: number; weight: number }[];
  global_multiple: number; curve: PowerLawCurve; backtest: BacktestStats;
  watchlist_size: number; board_size: number; early_size: number; live_size: number;
  total_implied_usd: number; audit: AuditSummary; rows: RadarRow[]; live: LiveRow[]; audit_rows: AuditEntry[];
}

export class SnapshotError extends Error {
  constructor(m: string) { super(m); this.name = 'SnapshotError'; }
}

export function buildBoardAndAudit(snapshot: Snapshot, sectors: SectorTable, families: LiveFamily[]): { board: BoardRow[]; audit: AuditEntry[] } {
  const liveStems = new Set(families.map((f) => familyStem(f.slug, f.name)));
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p, liveStems) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, MODEL.early_rows);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, v: value(p, snapshot.as_of, sectors) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : 1));
  const board: BoardRow[] = scored.map((s, i) => {
    const odds = airdropOdds(s.v.age, s.p.change_7d, watch.has(s.p.slug));
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
      token_status: 'pre-token',
      age_days: s.v.age,
      implied_value_usd: s.v.implied,
      implied_p25_usd: Math.min(s.v.p25, s.v.implied),
      implied_p75_usd: Math.max(s.v.p75, s.v.implied),
      airdrop_odds: odds,
      confidence: confidenceGrade(s.v.age, s.v.comparables, s.p.tvl_usd),
      verdict: farmVerdict(odds, s.v.implied, watch.has(s.p.slug)),
      on_watchlist: watch.has(s.p.slug),
      model: { multiple: s.v.multiple, sector_multiple: s.v.sector_multiple, size_multiple: s.v.size_multiple, comparables: s.v.comparables, shrinkage_weight: s.v.shrinkage_weight, source: s.v.source, momentum: s.v.momentum, timing: s.v.timing, conviction: s.v.conviction },
      farm_steps: farmSteps(s.p, s.v.age, odds),
    };
  });

  // Audit: a sample of the protocols the radar set aside, with the reason.
  const audit: AuditEntry[] = [];
  for (const p of snapshot.protocols) {
    if (chosen.has(p.slug)) continue;
    let reason: string | null = null;
    if (!isPreToken(p)) reason = 'records a token (market cap / symbol / CoinGecko id present)';
    else if (p.category === 'CEX') reason = 'centralized-exchange desk, out of scope';
    else if (VERSIONED.test(p.name) || SLUG_VERSIONED.test(p.slug)) reason = 'versioned sub-pool of another protocol';
    else if (liveStems.has(familyStem(p.slug, p.name))) reason = 'pool of a family whose token already trades';
    if (reason !== null && p.tvl_usd >= 20_000_000) audit.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason });
  }
  audit.sort((a, b) => b.tvl_usd - a.tvl_usd);
  return { board, audit: audit.slice(0, 30) };
}

export function liveRows(families: LiveFamily[], sectors: SectorTable): LiveRow[] {
  return families.slice(0, MODEL.live_display_rows).map((f) => ({
    slug: f.slug,
    name: f.name,
    category: f.category,
    chains: f.chains,
    tvl_usd: f.tvl_usd,
    mcap_usd: f.mcap_usd,
    change_7d: f.change_7d,
    mcap_to_tvl: r2(f.ratio),
    pred_mcap_usd: Math.round(f.tvl_usd * blendedMultiple({ category: f.category, tvl_usd: f.tvl_usd }, sectors).multiple),
    sub_protocols: f.sub_protocols,
  }));
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const families = buildLiveFamilies(snapshot);
  const sectors = learnSectorsFromFamilies(families);
  const { board, audit } = buildBoardAndAudit(snapshot, sectors, families);
  const live = liveRows(families, sectors);
  const backtest = runBacktest(families);
  const early = board.filter((r) => !r.on_watchlist).length;
  const sectorList = Object.entries(sectors.byCategory)
    .filter(([, v]) => v.comparables >= 3)
    .map(([category, v]) => ({ category, multiple: v.multiple, raw: v.raw_multiple, comparables: v.comparables, p25: v.p25_ratio, p75: v.p75_ratio, weight: v.shrinkage_weight }))
    .sort((a, b) => b.comparables - a.comparables);
  const totalImplied = board.reduce((s, r) => s + r.implied_value_usd, 0);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL.version,
    model_note:
      "Implied value = TVL × a blended multiple (Empirical-Bayes shrunk category market-cap/TVL median, geometrically blended 65/35 with a log-log power-law size curve, both fit on the snapshot's own deduplicated live-token families) × 7-day momentum × token-timing × conviction. Validated out-of-sample by Leave-One-Out Cross-Validation. No protocol is special-cased by name.",
    sectors: sectorList,
    global_multiple: sectors.global,
    curve: sectors.curve,
    backtest,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    total_implied_usd: totalImplied,
    audit: {
      total_protocols: snapshot.protocols.length,
      live_token: snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX').length,
      live_families: families.length,
      pre_token: snapshot.protocols.filter(isPreToken).length,
      watchlist: snapshot.watchlist.length,
      ranked: board.length,
      excluded: audit.length,
    },
    rows: board.map((r) => ({
      rank: r.rank, slug: r.slug, name: r.name, category: r.category, chains: r.chains,
      tvl_usd: r.tvl_usd, change_7d: r.change_7d, listed_at: r.listed_at, age_days: r.age_days,
      implied_value_usd: r.implied_value_usd, implied_p25_usd: r.implied_p25_usd, implied_p75_usd: r.implied_p75_usd,
      airdrop_odds: r.airdrop_odds, confidence: r.confidence, verdict: r.verdict, on_watchlist: r.on_watchlist,
      multiple: r.model.multiple, sector_multiple: r.model.sector_multiple, size_multiple: r.model.size_multiple,
      momentum: r.model.momentum, timing: r.model.timing, conviction: r.model.conviction, comparables: r.model.comparables, source: r.model.source,
      farm_steps: r.farm_steps,
    })),
    live,
    audit_rows: audit,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
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
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    return {
      slug: p.slug, name: p.name,
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
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} chars`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
