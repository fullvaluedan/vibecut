import { toast } from "sonner";

/**
 * Persistent, copyable failure surface for work the user paid real time for
 * (exports, transcription, AI runs). Regular toasts expire in seconds; a
 * failure after a minutes-long encode must stay on screen until dismissed and
 * be one click to copy into a bug report.
 */
export function reportFatal({
	title,
	error,
	context,
}: {
	/** User-facing headline, e.g. "Export failed". */
	title: string;
	error: unknown;
	/** Where it happened, for the copied report (e.g. "export/encode"). */
	context?: string;
}): void {
	const message =
		error instanceof Error ? error.message : String(error ?? "Unknown error");
	const stack = error instanceof Error ? (error.stack ?? "") : "";
	const details = [
		`VibeCut error report`,
		`When: ${new Date().toISOString()}`,
		context ? `Where: ${context}` : null,
		`What: ${title}`,
		`Message: ${message}`,
		stack ? `Stack:\n${stack}` : null,
	]
		.filter(Boolean)
		.join("\n");

	console.error(`[${context ?? "editor"}] ${title}:`, error);
	toast.error(title, {
		description: message,
		// Stays until the user dismisses it — the failure of a long job must
		// never expire off screen unseen.
		duration: Infinity,
		closeButton: true,
		action: {
			label: "Copy details",
			onClick: () => {
				void navigator.clipboard.writeText(details);
			},
		},
	});
}
