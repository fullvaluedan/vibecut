import { describe, expect, it } from "bun:test";
import {
	MAX_TRANSCRIBE_UPLOAD_BYTES,
	checkTranscribeUploadSize,
} from "@/media/transcribe-upload-limit";

/**
 * The size guard is the safety-critical fix for the live Groq 413 regression:
 * before it, a ~59 MB raw-WAV fallback (from a 32 min timeline whose Opus/AAC
 * encode didn't finish) was POSTed blind and Groq rejected it with 413. The
 * guard must refuse anything over the conservative cap and hand back an
 * actionable message instead of letting the fetch fire.
 */
describe("checkTranscribeUploadSize", () => {
	it("allows a compressed, single-digit MB blob", () => {
		expect(checkTranscribeUploadSize(3 * 1024 * 1024).ok).toBe(true);
	});

	it("allows a blob exactly at the cap (boundary is inclusive)", () => {
		expect(checkTranscribeUploadSize(MAX_TRANSCRIBE_UPLOAD_BYTES).ok).toBe(true);
	});

	it("refuses one byte over the cap", () => {
		const result = checkTranscribeUploadSize(MAX_TRANSCRIBE_UPLOAD_BYTES + 1);
		expect(result.ok).toBe(false);
	});

	it("refuses Dan's ~59 MB raw-WAV fallback with an actionable message", () => {
		const result = checkTranscribeUploadSize(59 * 1024 * 1024);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// Names the real alternative control so the user isn't stuck.
			expect(result.error).toContain("In browser");
			expect(result.error).toContain("Settings");
			// Reports the offending size, not a raw "413".
			expect(result.error).toContain("59 MB");
			expect(result.error).not.toContain("413");
		}
	});

	it("honors a custom cap", () => {
		expect(checkTranscribeUploadSize(5, 4).ok).toBe(false);
		expect(checkTranscribeUploadSize(4, 4).ok).toBe(true);
	});

	it("keeps the cap conservatively under Groq's ~25 MB free-tier limit", () => {
		expect(MAX_TRANSCRIBE_UPLOAD_BYTES).toBeLessThan(25 * 1024 * 1024);
	});
});
