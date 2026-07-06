"use client";

/**
 * Watches the timeline and quietly transcribes it a few seconds after the
 * audio content changes, so AI CUT and RUN HYPERFRAMES start from a warm
 * transcript cache instead of a cold Whisper run. On by default; toggle in
 * Settings → AI.
 */

import { useEffect, useMemo } from "react";
import { useEditor } from "@/editor/use-editor";
import { useAiSettingsStore } from "@/features/ai-generate/store";
import { useAiActivityStore } from "@/features/ai-generate/ai-activity-store";
import {
	computeTimelineAudioHash,
	ensureTimelineTranscript,
	getCachedTranscript,
	useTranscriptStatusStore,
} from "@/features/transcription/transcript-cache";
import { reportFatal } from "@/utils/report-error";

const SETTLE_MS = 5000;

// A background failure (model won't load, decode crash) re-fires on every
// edit; report each DISTINCT failure once per session instead of stacking
// identical toasts.
const reportedFailures = new Set<string>();

export function BackgroundTranscriber() {
	const editor = useEditor();
	const enabledSetting = useAiSettingsStore((s) => s.backgroundTranscriptionEnabled);
	const lowPowerMode = useAiSettingsStore((s) => s.lowPowerMode);
	// Don't run Whisper while a HyperFrames / AI CUT run is using the machine.
	const aiBusy = useAiActivityStore((s) => s.busy);
	const enabled = enabledSetting && !lowPowerMode && !aiBusy;
	const setStatus = useTranscriptStatusStore((s) => s.setStatus);
	// Subscribe to the cheap tracks REFERENCE (stable across scrub and selection;
	// only a real edit replaces it) and derive the O(n) audio hash off that with
	// useMemo — instead of recomputing the hash on every editor notify, which the
	// previous selector form did, including on every playhead-scrub mousemove.
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks);
	const hash = useMemo(() => {
		if (!tracks) return "";
		try {
			return computeTimelineAudioHash(editor);
		} catch {
			return "";
		}
	}, [tracks, editor]);

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
					if (/cancel/i.test(msg)) {
						setStatus("idle");
						return;
					}
					setStatus("error");
					// The status dot alone is easy to miss — AI CUT later fails
					// mysteriously on a cold cache. Say it once, persistently.
					if (!reportedFailures.has(msg)) {
						reportedFailures.add(msg);
						reportFatal({
							title: "Background transcription failed",
							error: err,
							context: "transcription/background",
						});
					}
				});
		}, SETTLE_MS);
		return () => clearTimeout(timer);
	}, [hash, enabled, editor, setStatus]);

	return null;
}
