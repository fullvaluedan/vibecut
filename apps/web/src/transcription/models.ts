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
	// path. UNVERIFIED in our transformers.js version — the U1 spike confirms each
	// actually emits word timestamps before the analysis selector adopts it.
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
