import { describe, expect, test } from "bun:test";
import { useAiActivityStore } from "../ai-activity-store";

describe("ai-activity-store (R1/KTD1: shared run-progress fields)", () => {
	test("starts idle: busy false, label/stage/cancel null", () => {
		const s = useAiActivityStore.getState();
		expect(s.busy).toBe(false);
		expect(s.label).toBeNull();
		expect(s.stage).toBeNull();
		expect(s.cancel).toBeNull();
	});

	test("setBusy keeps its original narrow meaning, independent of label/stage/cancel", () => {
		useAiActivityStore.getState().setBusy(true);
		expect(useAiActivityStore.getState().busy).toBe(true);
		expect(useAiActivityStore.getState().label).toBeNull();
		useAiActivityStore.getState().setBusy(false);
		expect(useAiActivityStore.getState().busy).toBe(false);
	});

	test("setLabel/setStage/setCancel each write their own field only", () => {
		const cancelFn = () => {};
		useAiActivityStore.getState().setLabel("AI Director");
		useAiActivityStore.getState().setStage("Transcribing...");
		useAiActivityStore.getState().setCancel(cancelFn);

		const s = useAiActivityStore.getState();
		expect(s.label).toBe("AI Director");
		expect(s.stage).toBe("Transcribing...");
		expect(s.cancel).toBe(cancelFn);

		// Clearing them (as endRun() does) returns to idle.
		useAiActivityStore.getState().setLabel(null);
		useAiActivityStore.getState().setStage(null);
		useAiActivityStore.getState().setCancel(null);
		const cleared = useAiActivityStore.getState();
		expect(cleared.label).toBeNull();
		expect(cleared.stage).toBeNull();
		expect(cleared.cancel).toBeNull();
	});
});
