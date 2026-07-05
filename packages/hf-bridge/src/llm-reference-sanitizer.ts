// --- LLM cut-reference sanitizer (FrameCut, U5 / R5) ---
//
// Anti-hallucination for every LLM cutting pass. An LLM must NEVER hand back raw
// seconds we trust: it references STABLE transcript ids instead - a line-id span
// (into the numbered catalog) or a word-index span (into the cached words[]) - and
// this module snaps each reference back to a real transcript position, converts to
// ticks with the injected `ticksPerSecond`, and drops anything that can't be a real
// cut: unknown ids/indices, out-of-range indices, reversed spans, exact duplicates,
// and (optionally) overlapping spans. A malformed response yields ZERO ops plus a
// stage-named error, never a throw, so one bad pass can't crash a Director run.
//
// Pure + wasm-free (ticksPerSecond is injected) so `bun test` covers it whole.

/** One numbered transcript line the LLM can reference by id. */
export interface ReferenceLine {
	lineId: string;
	startSec: number;
	endSec: number;
}

/** One word with its own timing, referenced by its index into this array. */
export interface ReferenceWord {
	startSec: number;
	endSec: number;
}

/** The transcript coordinates an LLM reference can resolve against. */
export interface ReferenceCatalog {
	lines: readonly ReferenceLine[];
	/** Present when the pass exposes word-index granularity (finer than a line). */
	words?: readonly ReferenceWord[];
}

/**
 * One raw op straight off the LLM. A cut references EITHER a line-id span
 * (`startLineId`..`endLineId`) OR a word-index span (`startWord`..`endWord`);
 * word indices win when both are present (finer grain). No `startSec`/`endSec`
 * field is read here - that is the whole point (R5: never raw seconds from an LLM).
 */
export interface RawReferencedOp {
	op?: unknown;
	startLineId?: unknown;
	endLineId?: unknown;
	startWord?: unknown;
	endWord?: unknown;
	reason?: unknown;
	confidence?: unknown;
}

/** A reference resolved to a real, tick-aligned removal span. */
export interface ResolvedOp {
	op: string;
	startTicks: number;
	endTicks: number;
	startSec: number;
	endSec: number;
	reason: string;
	confidence: number;
}

/** The result of parsing + resolving one pass. `error` is null on success. */
export interface SanitizeResult {
	ops: ResolvedOp[];
	error: string | null;
}

const KNOWN_OPS = new Set(["cut", "take_select"]);

function toTicks(sec: number, ticksPerSecond: number): number {
	return Math.round(sec * ticksPerSecond);
}

function isInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

/**
 * Resolve ONE raw op to a real span, or return null to DROP it. Word-index refs
 * take precedence over line-id refs. Returns null for: no usable reference, an
 * unknown line id, an out-of-range or non-integer word index, or a reversed /
 * zero-length span (end at or before start).
 */
function resolveOne({
	raw,
	catalog,
	ticksPerSecond,
	linesById,
}: {
	raw: RawReferencedOp;
	catalog: ReferenceCatalog;
	ticksPerSecond: number;
	linesById: Map<string, ReferenceLine>;
}): ResolvedOp | null {
	const op = typeof raw.op === "string" && KNOWN_OPS.has(raw.op) ? raw.op : "cut";
	let startSec: number;
	let endSec: number;

	if (raw.startWord !== undefined || raw.endWord !== undefined) {
		const words = catalog.words ?? [];
		if (!isInteger(raw.startWord) || !isInteger(raw.endWord)) return null;
		const a = raw.startWord;
		const b = raw.endWord;
		// Out of range (either endpoint) drops the whole op - we never clamp an
		// invented index into a valid one.
		if (a < 0 || b < 0 || a >= words.length || b >= words.length) return null;
		if (b < a) return null; // reversed
		startSec = words[a].startSec;
		endSec = words[b].endSec;
	} else if (typeof raw.startLineId === "string" && typeof raw.endLineId === "string") {
		const startLine = linesById.get(raw.startLineId);
		const endLine = linesById.get(raw.endLineId);
		if (!startLine || !endLine) return null; // unknown id
		startSec = startLine.startSec;
		endSec = endLine.endSec;
	} else {
		return null; // no usable reference (a raw-seconds-only op is dropped by design)
	}

	const startTicks = toTicks(startSec, ticksPerSecond);
	const endTicks = toTicks(endSec, ticksPerSecond);
	if (endTicks <= startTicks) return null; // reversed / zero-length after resolve

	const confidence = Number(raw.confidence);
	return {
		op,
		startTicks,
		endTicks,
		startSec,
		endSec,
		reason: String(raw.reason ?? "").slice(0, 240),
		confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
	};
}

/**
 * Resolve a list of raw referenced ops to clean tick-aligned removals. Drops
 * unknown/out-of-range/reversed refs (see `resolveOne`), then - processing in
 * ascending start order - drops any op whose span DUPLICATES or OVERLAPS an
 * already-kept op (`dropOverlapping`, on by default; exact duplicates are always
 * dropped). Stable: equal-start ops keep input order.
 */
export function resolveReferencedOps({
	rawOps,
	catalog,
	ticksPerSecond,
	dropOverlapping = true,
}: {
	rawOps: readonly RawReferencedOp[];
	catalog: ReferenceCatalog;
	ticksPerSecond: number;
	dropOverlapping?: boolean;
}): ResolvedOp[] {
	const linesById = new Map<string, ReferenceLine>();
	for (const line of catalog.lines) linesById.set(line.lineId, line);

	const resolved: ResolvedOp[] = [];
	for (const raw of rawOps) {
		const one = resolveOne({ raw, catalog, ticksPerSecond, linesById });
		if (one) resolved.push(one);
	}
	// Stable sort by start so overlap resolution is deterministic (keep the earliest).
	const ordered = resolved
		.map((op, i) => ({ op, i }))
		.sort((a, b) => a.op.startTicks - b.op.startTicks || a.i - b.i)
		.map((x) => x.op);

	const kept: ResolvedOp[] = [];
	const seen = new Set<string>();
	let lastEnd = Number.NEGATIVE_INFINITY;
	for (const op of ordered) {
		const key = `${op.startTicks}:${op.endTicks}`;
		if (seen.has(key)) continue; // exact duplicate
		if (dropOverlapping && op.startTicks < lastEnd) continue; // overlaps a kept op
		seen.add(key);
		kept.push(op);
		lastEnd = Math.max(lastEnd, op.endTicks);
	}
	return kept;
}

/**
 * Parse a raw LLM response and resolve its ops in one step. `raw` may be a JSON
 * string or an already-parsed object; the ops live under `operations` (or `ops`).
 * A non-JSON string, a non-object, or a missing/!array ops field yields ZERO ops
 * and a STAGE-NAMED error - never a throw - so a malformed pass is a skipped pass,
 * not a crashed Director run (R5 error path).
 */
export function sanitizeReferencedPlan({
	raw,
	stage,
	catalog,
	ticksPerSecond,
	dropOverlapping = true,
}: {
	raw: unknown;
	stage: string;
	catalog: ReferenceCatalog;
	ticksPerSecond: number;
	dropOverlapping?: boolean;
}): SanitizeResult {
	let value: unknown = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return { ops: [], error: `${stage}: response was not valid JSON` };
		}
	}
	if (typeof value !== "object" || value === null) {
		return { ops: [], error: `${stage}: response was not an object` };
	}
	const obj = value as Record<string, unknown>;
	const rawOps = Array.isArray(obj.operations)
		? obj.operations
		: Array.isArray(obj.ops)
			? obj.ops
			: null;
	if (rawOps === null) {
		return { ops: [], error: `${stage}: response had no operations array` };
	}
	const ops = resolveReferencedOps({
		rawOps: rawOps as RawReferencedOp[],
		catalog,
		ticksPerSecond,
		dropOverlapping,
	});
	return { ops, error: null };
}
