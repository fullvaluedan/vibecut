/**
 * Chronological clip ordering (live test: clips placed in REVERSE order weren't
 * re-sequenced by the Director). Parses a capture timestamp from a clip's filename
 * and plans a back-to-back reorder of a track's clips into chronological order.
 *
 * Pure + wasm-free → bun-testable. The orchestrator runs this as a PRE-PASS (before
 * transcribe/cut) and turns the plan into one MoveElementCommand (one undo), so the
 * Director then analyses the correctly-ordered timeline. Deterministic timestamp
 * order is the primary signal; content/LLM ordering for un-timestamped clips is a
 * separate follow-up (a full reorder can't be fused with the cut plan).
 */

// "2026-06-22 23-37-45" / "2026_06_22T23.37.45" etc. — date and time with separators.
const SEPARATED = /(\d{4})-(\d{2})-(\d{2})[ _T-](\d{2})[-:.](\d{2})[-:.](\d{2})/;
// "20260622_233745" / "20260622233745" — compact (e.g. screen-recorder names).
// Digit-anchored so a 14-digit timestamp embedded in a LONGER numeric id (e.g. a
// 16-digit asset id) doesn't match its first 14 digits as a bogus timestamp.
const COMPACT = /(?<!\d)(\d{4})(\d{2})(\d{2})[ _T-]?(\d{2})(\d{2})(\d{2})(?!\d)/;

/**
 * A monotonic sort key derived from a date-time embedded in `name`, or null when
 * none is present. The key is comparable (earlier < later); it is NOT an epoch and
 * needs no Date/timezone handling. Field ranges are validated so a random digit run
 * doesn't read as a bogus timestamp.
 */
export function parseClipTimestamp(name: string): number | null {
	const m = SEPARATED.exec(name) ?? COMPACT.exec(name);
	if (!m) {
		return null;
	}
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const hour = Number(m[4]);
	const minute = Number(m[5]);
	const second = Number(m[6]);
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > 31 ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		return null;
	}
	// Bases exceed each field's max so the key is strictly monotonic in time.
	return ((((year * 13 + month) * 32 + day) * 24 + hour) * 60 + minute) * 60 + second;
}

/** One clip on a track, in plain ticks (wasm-free so it's unit-testable). */
export interface ChronoClip {
	elementId: string;
	name: string;
	startTimeTicks: number;
	durationTicks: number;
}

/** A planned move: put `elementId` at `newStartTimeTicks` (same track). */
export interface ChronoMove {
	elementId: string;
	newStartTimeTicks: number;
}

/**
 * Plan a chronological reorder of one track's clips, laid back-to-back from t=0 in
 * filename-timestamp order. Returns null (NO reorder) when:
 *  - fewer than 2 clips,
 *  - not EVERY clip has a parseable timestamp (defer to content/LLM ordering),
 *  - every timestamp is identical (can't establish an order), or
 *  - the clips are already in chronological order (don't disturb intentional gaps).
 * Ties (equal timestamps) keep their current relative order (stable).
 */
export function planChronologicalReorder({
	clips,
}: {
	clips: readonly ChronoClip[];
}): ChronoMove[] | null {
	if (clips.length < 2) {
		return null;
	}
	const stamped: { clip: ChronoClip; ts: number; order: number }[] = [];
	for (let i = 0; i < clips.length; i++) {
		const ts = parseClipTimestamp(clips[i].name);
		if (ts === null) {
			return null; // mixed/un-timestamped → not a clean deterministic reorder
		}
		stamped.push({ clip: clips[i], ts, order: i });
	}
	if (new Set(stamped.map((s) => s.ts)).size < 2) {
		return null; // all identical → ambiguous, leave as-is
	}

	const chrono = [...stamped].sort((a, b) => a.ts - b.ts || a.order - b.order);
	const byTimeline = [...stamped].sort(
		(a, b) => a.clip.startTimeTicks - b.clip.startTimeTicks,
	);
	const alreadyOrdered = chrono.every(
		(s, i) => s.clip.elementId === byTimeline[i].clip.elementId,
	);
	if (alreadyOrdered) {
		return null;
	}

	const moves: ChronoMove[] = [];
	let cursorTicks = 0;
	for (const s of chrono) {
		moves.push({ elementId: s.clip.elementId, newStartTimeTicks: cursorTicks });
		cursorTicks += s.clip.durationTicks;
	}
	return moves;
}
