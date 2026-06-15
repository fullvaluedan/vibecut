"use client";

/**
 * Watches the timeline and quietly transcribes it a few seconds after the
 * audio content changes, so AI CUT and RUN HYPERFRAMES start from a warm
 * transcript cache instead of a cold Whisper run. On by default; toggle in
 * Settings → AI.
 */

import { useEffect } from "react";
import { useEditor } from "@/editor/use-editor";
import { useAiSettingsStore } from "@/features/ai-generate/store";
import { useAiActivityStore } from "@/features/ai-generate/ai-activity-store";
import {
	computeTimelineAudioHash,
	ensureTimelineTranscript,
	getCachedTranscript,
	useTranscriptStatusStore,
} from "@/features/transcription/transcript-cache";

const SETTLE_MS = 5000;

export function BackgroundTranscriber() {
	const editor = useEditor();
	const enabledSetting = useAiSettingsStore((s) => s.backgroundTranscriptionEnabled);
	const lowPowerMode = useAiSettingsStore((s) => s.lowPowerMode);
	// Don't run Whisper while a HyperFrames / AI CUT run is using the machine.
	const aiBusy = useAiActivityStore((s) => s.busy);
	const enabled = enabledSetting && !lowPowerMode && !aiBusy;
	const setStatus = useTranscriptStatusStore((s) => s.setStatus);
	const hash = useEditor((e) => {
		try {
			return computeTimelineAudioHash(e);
		} catch {
			return "";
		}
	});

	useEffect(() => {
		if (!enabled || !hash || hash.startsWith("0-")) {
			setStatus("idle");
			return;
		}
		if (getCachedTranscript(editor)) {
			// A hash match (even an empty/no-speech transcript) is ready.
			setStatus("ready");
			return;
		}
		// Let the edit settle — don't transcribe in the middle of a drag.
		const timer = setTimeout(() => {
			setStatus("transcribing");
			ensureTimelineTranscript({ editor })
				.then(() => setStatus("ready"))
				.catch((err) => {
					// Surface real failures (the 'error' status was dead code);
					// a genuine cancellation just goes back to idle.
					const msg = String((err as Error)?.message ?? err);
					setStatus(/cancel/i.test(msg) ? "idle" : "error");
				});
		}, SETTLE_MS);
		return () => clearTimeout(timer);
	}, [hash, enabled, editor, setStatus]);

	return null;
}
