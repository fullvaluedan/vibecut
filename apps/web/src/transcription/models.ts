import type {
	TranscriptionModel,
	TranscriptionModelId,
} from "./types";

export const TRANSCRIPTION_MODELS: TranscriptionModel[] = [
	{
		id: "whisper-tiny",
		name: "Tiny",
		huggingFaceId: "onnx-community/whisper-tiny",
		description: "Fastest, lower accuracy",
	},
	{
		id: "whisper-small",
		name: "Small",
		huggingFaceId: "onnx-community/whisper-small",
		description: "Good balance of speed and accuracy",
	},
	{
		id: "whisper-medium",
		name: "Medium",
		huggingFaceId: "onnx-community/whisper-medium",
		description: "Higher accuracy, slower",
	},
	{
		id: "whisper-large-v3-turbo",
		name: "Large v3 Turbo",
		huggingFaceId: "onnx-community/whisper-large-v3-turbo",
		description: "Best accuracy, requires WebGPU for good performance",
	},
	// Word-timestamp-capable exports (cross-attention) for the Director/analysis
	// path. `whisper-tiny-timestamped` is VERIFIED (U1 spike, 2026-06-24: loads +
	// emits word timestamps in our transformers.js) and is the analysis default;
	// base/medium remain UNVERIFIED (base failed a headless load — confirm in-app
	// before the selector adopts them).
	{
		id: "whisper-tiny-timestamped",
		name: "Tiny (word timestamps)",
		huggingFaceId: "onnx-community/whisper-tiny_timestamped",
		description: "Fast, multilingual, emits word-level timestamps — the analysis-path default",
	},
	{
		id: "whisper-base-timestamped",
		name: "Base (word timestamps)",
		huggingFaceId: "onnx-community/whisper-base_timestamped",
		description: "Small, multilingual, emits word-level timestamps",
	},
	{
		id: "whisper-medium-en-timestamped",
		name: "Medium EN (word timestamps)",
		huggingFaceId: "onnx-community/whisper-medium.en_timestamped",
		description: "Accurate, English-only, emits word-level timestamps",
	},
];

export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModelId =
	"whisper-small";
