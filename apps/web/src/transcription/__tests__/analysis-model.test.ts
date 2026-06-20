import { describe, expect, test } from "bun:test";
import {
	ANALYSIS_TINY_THRESHOLD_SECONDS,
	selectAnalysisModel,
} from "../analysis-model";

describe("selectAnalysisModel", () => {
	test("short timelines use the accurate Small model", () => {
		expect(selectAnalysisModel({ durationSec: 0 })).toBe("whisper-small");
		expect(selectAnalysisModel({ durationSec: 60 })).toBe("whisper-small");
		expect(
			selectAnalysisModel({ durationSec: ANALYSIS_TINY_THRESHOLD_SECONDS }),
		).toBe("whisper-small"); // boundary is inclusive of Small
	});

	test("long timelines use the fast Tiny model", () => {
		expect(
			selectAnalysisModel({ durationSec: ANALYSIS_TINY_THRESHOLD_SECONDS + 1 }),
		).toBe("whisper-tiny");
		expect(selectAnalysisModel({ durationSec: 973.93 })).toBe("whisper-tiny"); // the 16-min repro
	});
});
