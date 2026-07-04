import { describe, expect, mock, test } from "bun:test";

// The U4 primary correctness test (KTD5): after one ripple-delete, the local
// words are remapped left by the removed duration, so a SECOND delete before any
// refresh resolves against the already-shifted (live-timeline) coordinates rather
// than the original pre-shift timestamps. Mock @/wasm + RemoveRangesCommand so the
// executed ranges are captured as ticks without a real EditorCore.
mock.module("@/wasm", () => ({ TICKS_PER_SECOND: 120_000 }));

class FakeRemoveRangesCommand {
	readonly ranges: { start: number; end: number }[];
	constructor(args: { ranges: { start: number; end: number }[] }) {
		this.ranges = args.ranges;
	}
}
mock.module("@/commands/timeline/track/remove-ranges", () => ({
	RemoveRangesCommand: FakeRemoveRangesCommand,
}));

const { deleteTranscriptSelection } = await import(
	"../delete-transcript-selection"
);
const { remapTranscriptTimestamps } = await import(
	"../remap-transcript-timestamps"
);

describe("delete then remap then delete", () => {
	test("second delete cuts the shifted (post-first-delete) footage", () => {
		const executed: FakeRemoveRangesCommand[] = [];
		const editor = {
			command: {
				execute: ({ command }: { command: unknown }) =>
					executed.push(command as FakeRemoveRangesCommand),
			},
		};
		let words = Array.from({ length: 20 }, (_, i) => ({
			start: i,
			end: i + 0.9,
			text: `w${i}`,
		}));

		// Delete range A = words [2, 4]: seconds 2 .. 4.9, removed duration 2.9.
		const rangeA = deleteTranscriptSelection({
			editor,
			selection: { startIndex: 2, endIndex: 4, granularity: "word" },
			words,
			segments: [],
		});
		expect(rangeA).toEqual({ startSec: 2, endSec: 4.9 });
		words = remapTranscriptTimestamps({
			items: words,
			deletedEndSec: rangeA!.endSec,
			removedDurationSec: rangeA!.endSec - rangeA!.startSec,
		});

		// Delete range B = words [10, 11] on the REMAPPED array. Originally 10 ..
		// 11.9; after A's removal it must resolve to 7.1 .. 9.0.
		const rangeB = deleteTranscriptSelection({
			editor,
			selection: { startIndex: 10, endIndex: 11, granularity: "word" },
			words,
			segments: [],
		});
		expect(rangeB!.startSec).toBeCloseTo(7.1, 6);
		expect(rangeB!.endSec).toBeCloseTo(9.0, 6);

		// The executed tick range for B reflects the shift, not the pre-shift 10s.
		expect(executed).toHaveLength(2);
		expect(executed[1].ranges[0].start).toBe(Math.round(7.1 * 120_000));
		expect(executed[1].ranges[0].start).not.toBe(Math.round(10 * 120_000));
	});
});
