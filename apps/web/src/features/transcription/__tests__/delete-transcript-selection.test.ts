import { describe, expect, mock, test } from "bun:test";

// delete-transcript-selection imports `@/wasm` + RemoveRangesCommand at module top;
// stub both so it imports under bun and the command captures its ranges (matching
// apply-plan.test.ts). The Fake carries identity via instanceof so the single-undo /
// no-trackId assertions hold without a real EditorCore.
mock.module("@/wasm", () => ({ TICKS_PER_SECOND: 120_000 }));

class FakeRemoveRangesCommand {
	readonly ranges: { start: number; end: number; trackId?: string }[];
	constructor(args: {
		ranges: { start: number; end: number; trackId?: string }[];
	}) {
		this.ranges = args.ranges;
	}
}
mock.module("@/commands/timeline/track/remove-ranges", () => ({
	RemoveRangesCommand: FakeRemoveRangesCommand,
}));

const { deleteTranscriptSelection } = await import(
	"../delete-transcript-selection"
);

const words = Array.from({ length: 20 }, (_, i) => ({
	start: i,
	end: i + 0.9,
	text: `w${i}`,
}));

function makeEditor() {
	const executed: FakeRemoveRangesCommand[] = [];
	return {
		editor: {
			command: {
				execute: ({ command }: { command: unknown }) =>
					executed.push(command as FakeRemoveRangesCommand),
			},
		},
		executed,
	};
}

describe("deleteTranscriptSelection", () => {
	test("runs exactly one RemoveRangesCommand with a no-trackId range", () => {
		const { editor, executed } = makeEditor();
		const range = deleteTranscriptSelection({
			editor,
			selection: { startIndex: 5, endIndex: 8, granularity: "word" },
			words,
			segments: [],
		});

		expect(executed).toHaveLength(1);
		expect(executed[0]).toBeInstanceOf(FakeRemoveRangesCommand);
		expect(executed[0].ranges).toHaveLength(1);
		expect(executed[0].ranges[0].trackId).toBeUndefined();
		// Seconds resolved from the words, converted to ticks at the boundary.
		expect(executed[0].ranges[0]).toEqual({
			start: Math.round(words[5].start * 120_000),
			end: Math.round(words[8].end * 120_000),
		});
		expect(range).toEqual({ startSec: words[5].start, endSec: words[8].end });
	});

	test("invalid selection executes no command and returns null", () => {
		const { editor, executed } = makeEditor();
		const range = deleteTranscriptSelection({
			editor,
			selection: { startIndex: 8, endIndex: 3, granularity: "word" },
			words,
			segments: [],
		});
		expect(executed).toHaveLength(0);
		expect(range).toBeNull();
	});
});
