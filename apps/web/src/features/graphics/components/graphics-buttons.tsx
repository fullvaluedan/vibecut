"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { startGraphicsJob, importGraphicsRender } from "../run-graphics";
import { useGraphicsJobStore } from "../graphics-job-store";
import { HEARTBEAT_STALE_MS, type GraphicsEngine } from "../job-types";

const PHASE_LABEL: Record<string, string> = {
	extracting: "Preparing",
	generating: "Generating graphics",
	"proof-rendering": "Rendering proof",
	"proof-ready": "Proof ready",
	"full-rendering": "Rendering full video",
	importing: "Adding to timeline",
	done: "Done",
	error: "Failed",
	cancelled: "Cancelled",
};

/**
 * REMOTION + HYPERFRAMES-GRAPHICS buttons (dan-video skill graphics passes) plus the
 * live job panel: progress bar, a heartbeat dot so a ~2hr render never looks frozen,
 * the last log lines, and the proof-ready Approve gate.
 */
export function GraphicsButtons() {
	const editor = useEditor((e) => e);
	const { job, starting, error, pendingImport, track, setStarting, setError, approve, cancel, clearPendingImport, dismiss } =
		useGraphicsJobStore();

	// Tick so the heartbeat freshness re-evaluates without a job update.
	const [, force] = useState(0);
	useEffect(() => {
		if (!job || ["done", "error", "cancelled"].includes(job.phase)) return;
		const t = setInterval(() => force((n) => n + 1), 1000);
		return () => clearInterval(t);
	}, [job]);

	// When the full render lands, pull it back and drop it on a new video + audio track.
	// clearPendingImport() first so a re-render mid-import cannot double-place it.
	useEffect(() => {
		if (!pendingImport || !job) return;
		const engine = job.engine;
		clearPendingImport();
		void (async () => {
			const t = toast.loading("Adding the graphics render to your timeline...");
			try {
				const placed = await importGraphicsRender({ editor, id: job.id, engine });
				toast.success(
					placed.splitAudio
						? "Added as a new video track + its own audio track."
						: "Added as a new video track.",
					{ id: t },
				);
			} catch (e) {
				toast.error(e instanceof Error ? e.message : String(e), { id: t });
			}
		})();
	}, [pendingImport, job, editor, clearPendingImport]);

	const busy = starting || (job !== null && !["done", "error", "cancelled"].includes(job.phase));

	const run = async (engine: GraphicsEngine) => {
		if (busy) return;
		setStarting(true);
		setError(null);
		try {
			const id = await startGraphicsJob({
				editor,
				engine,
				onProgress: (d) => toast.info(d),
			});
			track(id);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setError(msg);
			toast.error(msg);
		} finally {
			setStarting(false);
		}
	};

	const stale = job ? Date.now() - job.heartbeatAt > HEARTBEAT_STALE_MS : false;
	const pct = job ? Math.round((job.progress ?? 0) * 100) : 0;

	return (
		<div className="flex items-center gap-1.5">
			<Button size="sm" variant="secondary" disabled={busy} onClick={() => run("remotion")}>
				REMOTION
			</Button>
			<Button size="sm" variant="secondary" disabled={busy} onClick={() => run("hyperframes")}>
				HF GRAPHICS
			</Button>

			{job && !["done", "cancelled"].includes(job.phase) && (
				<div className="ml-2 flex min-w-[240px] flex-col gap-1 rounded-md border bg-background/80 px-2 py-1.5 text-xs">
					<div className="flex items-center gap-2">
						<span
							className={cn(
								"inline-block h-2 w-2 rounded-full",
								job.phase === "error" ? "bg-red-500" : stale ? "bg-amber-500" : "bg-green-500 animate-pulse",
							)}
							title={stale ? "No update in 30s (may be stuck)" : "Alive"}
						/>
						<span className="font-medium">{PHASE_LABEL[job.phase] ?? job.phase}</span>
						<span className="ml-auto tabular-nums text-muted-foreground">
							{job.phase === "proof-ready" ? "" : `${pct}%`}
						</span>
					</div>
					{job.phase !== "proof-ready" && <Progress value={pct} className="h-1" />}
					<div className="truncate text-muted-foreground" title={job.message}>
						{stale ? "No update for 30s. Still waiting..." : job.message}
					</div>

					{job.phase === "proof-ready" && (
						<div className="flex flex-col gap-1 pt-1">
							<span className="text-muted-foreground">Proof rendered. Review it, then approve the full ~2hr render.</span>
							<div className="flex items-center gap-2">
								<Button
									size="sm"
									variant="outline"
									className="h-6 px-2"
									onClick={() =>
										window.open(`/api/graphics/file?id=${encodeURIComponent(job.id)}&kind=proof`, "_blank")
									}
								>
									View proof
								</Button>
								<Button size="sm" className="h-6 px-2" onClick={() => void approve()}>
									Render full
								</Button>
							</div>
						</div>
					)}

					<div className="flex items-center justify-end gap-2 pt-0.5">
						{job.phase === "error" && <span className="text-red-500">{job.error}</span>}
						<Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => void cancel()}>
							Cancel
						</Button>
					</div>
				</div>
			)}

			{job && ["done", "error"].includes(job.phase) && (
				<Button size="sm" variant="ghost" onClick={dismiss}>
					{job.phase === "error" ? "Dismiss error" : "Clear"}
				</Button>
			)}
			{error && !job && <span className="ml-2 text-xs text-red-500">{error}</span>}
		</div>
	);
}
