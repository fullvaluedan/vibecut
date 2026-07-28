import { describe, expect, test } from "bun:test";
import type { DirectorOp, DirectorOpCategory } from "@framecut/hf-bridge";
import {
	CATEGORY_LABEL,
	DIRECTOR_OP_CATEGORIES,
	MAX_LEDGER_NOTE_CHARS,
	MAX_LEDGER_RUNS,
	appendRunRecord,
	deriveLedgerTasteNote,
	normalizeRunLedger,
	readRunLedger,
	recordApplyDecisions,
	recordPostApplyRevisions,
	resolveDirectorOpCategory,
	startRunRecord,
	type RunLedgerRecord,
} from "../run-ledger";

/**
 * U3: the run ledger's pure functions, following the `text-styles` test suite
 * as the idiom precedent (operate on plain project-shaped objects, exercise
 * hostile/normalize input directly, no store or editor involved).
 */

function op({
	id,
	kind = "cut",
	category,
	defaultAccept,
}: {
	id: string;
	kind?: DirectorOp["op"];
	category?: DirectorOpCategory;
	defaultAccept?: boolean;
}): DirectorOp {
	return {
		id,
		op: kind,
		startSec: 0,
		endSec: 1,
		reason: "r",
		confidence: 0.8,
		...(category ? { category } : {}),
		...(defaultAccept !== undefined ? { defaultAccept } : {}),
	};
}

describe("resolveDirectorOpCategory", () => {
	test("an explicit category wins over the op kind", () => {
		expect(resolveDirectorOpCategory({ op: "cut", category: "filler" })).toBe(
			"filler",
		);
	});

	test("degrades an un-tagged op to a category by op kind", () => {
		expect(resolveDirectorOpCategory({ op: "cut" })).toBe("llm");
		expect(resolveDirectorOpCategory({ op: "take_select" })).toBe("take");
		expect(resolveDirectorOpCategory({ op: "reorder" })).toBe("reorder");
	});

	test("keep carries no signal", () => {
		expect(resolveDirectorOpCategory({ op: "keep" })).toBeNull();
	});
});

describe("startRunRecord (plan-open snapshot)", () => {
	test("counts proposed and default-accepted per category", () => {
		const record = startRunRecord({
			operations: [
				op({ id: "a", category: "filler" }),
				op({ id: "b", category: "filler" }),
				op({ id: "c", category: "filler", defaultAccept: false }),
				op({ id: "d", category: "speculation", defaultAccept: false }),
			],
		});
		expect(record.categories.filler).toEqual({
			proposed: 3,
			defaultAccepted: 2,
			toggledOn: 0,
			toggledOff: 0,
			applied: 0,
			revisedOff: 0,
		});
		expect(record.categories.speculation).toEqual({
			proposed: 1,
			defaultAccepted: 0,
			toggledOn: 0,
			toggledOff: 0,
			applied: 0,
			revisedOff: 0,
		});
	});

	test("ops that resolve to no category (keep) are excluded", () => {
		const record = startRunRecord({ operations: [op({ id: "a", kind: "keep" })] });
		expect(record.categories).toEqual({});
	});

	test("empty operations produce an empty record with a timestamp", () => {
		const record = startRunRecord({ operations: [] });
		expect(record.categories).toEqual({});
		expect(typeof record.at).toBe("number");
	});
});

describe("recordApplyDecisions (toggle-delta computation)", () => {
	test("a recommended row turned off counts as toggledOff, not applied", () => {
		const base = startRunRecord({
			operations: [op({ id: "a", category: "filler" })],
		});
		const record = recordApplyDecisions({
			record: base,
			operations: [op({ id: "a", category: "filler" })],
			decisions: { a: false },
		});
		expect(record.categories.filler).toMatchObject({
			proposed: 1,
			defaultAccepted: 1,
			toggledOff: 1,
			toggledOn: 0,
			applied: 0,
		});
	});

	test("an opt-in row turned on counts as toggledOn and applied", () => {
		const operations = [op({ id: "a", category: "speculation", defaultAccept: false })];
		const base = startRunRecord({ operations });
		const record = recordApplyDecisions({
			record: base,
			operations,
			decisions: { a: true },
		});
		expect(record.categories.speculation).toMatchObject({
			toggledOn: 1,
			toggledOff: 0,
			applied: 1,
		});
	});

	test("an untouched recommended row counts as applied, no toggle either way", () => {
		const operations = [op({ id: "a", category: "filler" })];
		const base = startRunRecord({ operations });
		const record = recordApplyDecisions({
			record: base,
			operations,
			decisions: { a: true },
		});
		expect(record.categories.filler).toMatchObject({
			applied: 1,
			toggledOn: 0,
			toggledOff: 0,
		});
	});

	test("does not mutate the record it is handed", () => {
		const operations = [op({ id: "a", category: "filler" })];
		const base = startRunRecord({ operations });
		recordApplyDecisions({ record: base, operations, decisions: { a: false } });
		expect(base.categories.filler?.toggledOff).toBe(0);
	});
});

describe("appendRunRecord", () => {
	test("appends onto an empty ledger", () => {
		const record = startRunRecord({ operations: [] });
		expect(appendRunRecord({ ledger: [], record })).toEqual([record]);
	});

	test("caps at MAX_LEDGER_RUNS, dropping the oldest first", () => {
		let ledger: RunLedgerRecord[] = [];
		for (let i = 0; i < MAX_LEDGER_RUNS + 5; i++) {
			ledger = appendRunRecord({
				ledger,
				record: { at: i, categories: {} },
			});
		}
		expect(ledger).toHaveLength(MAX_LEDGER_RUNS);
		expect(ledger[0].at).toBe(5); // the first 5 (0-4) fell off
		expect(ledger[ledger.length - 1].at).toBe(MAX_LEDGER_RUNS + 4);
	});
});

describe("recordPostApplyRevisions", () => {
	const operations = [
		op({ id: "a", category: "filler" }),
		op({ id: "b", category: "speculation" }),
	];

	test("no-op on an empty ledger (nothing to attribute the revision to)", () => {
		const ledger: RunLedgerRecord[] = [];
		const next = recordPostApplyRevisions({
			ledger,
			operations,
			before: { a: true },
			after: { a: false },
		});
		expect(next).toBe(ledger);
	});

	test("a true->false transition increments revisedOff on the LATEST record only", () => {
		const older: RunLedgerRecord = { at: 1, categories: { filler: {
			proposed: 1, defaultAccepted: 1, toggledOn: 0, toggledOff: 0, applied: 1, revisedOff: 0,
		} } };
		const latest: RunLedgerRecord = { at: 2, categories: {} };
		const next = recordPostApplyRevisions({
			ledger: [older, latest],
			operations,
			before: { a: true },
			after: { a: false },
		});
		expect(next[0]).toBe(older); // untouched
		expect(next[1].categories.filler?.revisedOff).toBe(1);
	});

	test("a false->true transition (re-check) is not a revision", () => {
		const ledger: RunLedgerRecord[] = [{ at: 1, categories: {} }];
		const next = recordPostApplyRevisions({
			ledger,
			operations,
			before: { a: false },
			after: { a: true },
		});
		expect(next).toBe(ledger);
	});

	test("multiple ops flipped off in one call attribute to their own categories", () => {
		const ledger: RunLedgerRecord[] = [{ at: 1, categories: {} }];
		const next = recordPostApplyRevisions({
			ledger,
			operations,
			before: { a: true, b: true },
			after: { a: false, b: false },
		});
		expect(next[0].categories.filler?.revisedOff).toBe(1);
		expect(next[0].categories.speculation?.revisedOff).toBe(1);
	});

	test("ignores an id not present in the current operations", () => {
		const ledger: RunLedgerRecord[] = [{ at: 1, categories: {} }];
		const next = recordPostApplyRevisions({
			ledger,
			operations,
			before: { ghost: true },
			after: { ghost: false },
		});
		expect(next).toBe(ledger);
	});
});

describe("readRunLedger", () => {
	test("reads an empty list from a project saved before the feature existed", () => {
		expect(readRunLedger({ project: {} })).toEqual([]);
		expect(readRunLedger({ project: null })).toEqual([]);
		expect(readRunLedger({ project: undefined })).toEqual([]);
	});

	test("reads the stored ledger through", () => {
		const ledger: RunLedgerRecord[] = [{ at: 1, categories: {} }];
		expect(readRunLedger({ project: { runLedger: ledger } })).toBe(ledger);
	});
});

describe("normalizeRunLedger (hostile shapes on load)", () => {
	test("returns an empty list for anything that is not an array", () => {
		expect(normalizeRunLedger({ raw: undefined })).toEqual([]);
		expect(normalizeRunLedger({ raw: null })).toEqual([]);
		expect(normalizeRunLedger({ raw: "ledger" })).toEqual([]);
		expect(normalizeRunLedger({ raw: { at: 1 } })).toEqual([]);
	});

	test("drops records with no usable timestamp", () => {
		expect(
			normalizeRunLedger({
				raw: [null, 42, {}, { at: "yesterday" }, { at: -1 }],
			}),
		).toEqual([]);
	});

	test("strips unknown category keys and malformed counts", () => {
		const [record] = normalizeRunLedger({
			raw: [
				{
					at: 1,
					categories: {
						filler: {
							proposed: 3,
							defaultAccepted: 2,
							toggledOn: 0,
							toggledOff: 1,
							applied: 2,
							revisedOff: 0,
						},
						"not-a-category": { proposed: 1, defaultAccepted: 1, toggledOn: 0, toggledOff: 0, applied: 1, revisedOff: 0 },
						speculation: { proposed: "many" }, // malformed, dropped
					},
				},
			],
		});
		expect(Object.keys(record.categories)).toEqual(["filler"]);
	});

	test("a record with no categories field normalizes to an empty map", () => {
		const [record] = normalizeRunLedger({ raw: [{ at: 1 }] });
		expect(record.categories).toEqual({});
	});

	test("re-caps a hand-edited file with more than MAX_LEDGER_RUNS entries", () => {
		const raw = Array.from({ length: MAX_LEDGER_RUNS + 3 }, (_, i) => ({
			at: i,
			categories: {},
		}));
		const normalized = normalizeRunLedger({ raw });
		expect(normalized).toHaveLength(MAX_LEDGER_RUNS);
		expect(normalized[0].at).toBe(3); // oldest 3 dropped
	});

	test("round-trips through JSON the way storage stores it", () => {
		const record = recordApplyDecisions({
			record: startRunRecord({
				operations: [op({ id: "a", category: "filler" })],
			}),
			operations: [op({ id: "a", category: "filler" })],
			decisions: { a: true },
		});
		const reloaded = normalizeRunLedger({
			raw: JSON.parse(JSON.stringify([record])),
		});
		expect(reloaded).toEqual([record]);
	});
});

describe("deriveLedgerTasteNote (aggregation)", () => {
	test("an empty ledger produces no note", () => {
		expect(deriveLedgerTasteNote([])).toBe("");
	});

	test("a single run below the sample threshold stays silent", () => {
		const ledger: RunLedgerRecord[] = [
			{
				at: 1,
				categories: {
					filler: {
						proposed: 1,
						defaultAccepted: 1,
						toggledOn: 0,
						toggledOff: 0,
						applied: 1,
						revisedOff: 0,
					},
				},
			},
		];
		expect(deriveLedgerTasteNote(ledger)).toBe("");
	});

	test("high acceptance across runs reads as 'stay aggressive'", () => {
		const ledger: RunLedgerRecord[] = [
			{
				at: 1,
				categories: {
					filler: {
						proposed: 5,
						defaultAccepted: 5,
						toggledOn: 0,
						toggledOff: 0,
						applied: 5,
						revisedOff: 0,
					},
				},
			},
			{
				at: 2,
				categories: {
					filler: {
						proposed: 5,
						defaultAccepted: 5,
						toggledOn: 0,
						toggledOff: 0,
						applied: 5,
						revisedOff: 0,
					},
				},
			},
		];
		const note = deriveLedgerTasteNote(ledger);
		expect(note).toContain(CATEGORY_LABEL.filler);
		expect(note).toContain("aggressive");
		expect(note).toContain("2");
	});

	test("frequent reversal across runs reads as 'stay conservative', overriding a high-applied share", () => {
		const ledger: RunLedgerRecord[] = [
			{
				at: 1,
				categories: {
					speculation: {
						proposed: 6,
						defaultAccepted: 6,
						toggledOn: 0,
						toggledOff: 0,
						applied: 6,
						revisedOff: 3, // half reverted post-apply despite a 100% apply rate
					},
				},
			},
		];
		const note = deriveLedgerTasteNote(ledger);
		expect(note).toContain(CATEGORY_LABEL.speculation);
		expect(note).toContain("conservative");
	});

	test("stays hard-capped to MAX_LEDGER_NOTE_CHARS even with every category firing", () => {
		const categories: RunLedgerRecord["categories"] = {};
		for (const key of DIRECTOR_OP_CATEGORIES) {
			categories[key] = {
				proposed: 10,
				defaultAccepted: 10,
				toggledOn: 0,
				toggledOff: 0,
				applied: 10,
				revisedOff: 0,
			};
		}
		const ledger: RunLedgerRecord[] = [
			{ at: 1, categories },
			{ at: 2, categories },
		];
		const note = deriveLedgerTasteNote(ledger);
		expect(note.length).toBeLessThanOrEqual(MAX_LEDGER_NOTE_CHARS);
		expect(note.length).toBeGreaterThan(0);
	});
});
