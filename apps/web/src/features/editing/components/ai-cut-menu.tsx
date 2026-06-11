"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useEditor } from "@/editor/use-editor";
import { runRemoveSilences } from "@/features/editing/remove-silences";
import { runRemoveRepeats } from "@/features/editing/remove-repeats";
import { runAutocut } from "@/features/editing/autocut";
import { HugeiconsIcon } from "@hugeicons/react";
import { ScissorIcon } from "@hugeicons/core-free-icons";

const fmtSec = (sec: number) => `${sec.toFixed(1)}s`;

export function AiCutMenu() {
	const editor = useEditor();
	const [busy, setBusy] = useState<string | null>(null);

	const run = async (
		label: string,
		fn: () => Promise<{ cuts: number; removedSec: number }>,
	) => {
		if (busy) return;
		setBusy(label);
		const toastId = toast.loading(`${label}...`);
		try {
			const { cuts, removedSec } = await fn();
			if (cuts === 0) {
				toast.info(`${label}: nothing to cut`, { id: toastId });
			} else {
				toast.success(
					`${label}: ${cuts} cut${cuts === 1 ? "" : "s"}, ${fmtSec(removedSec)} removed`,
					{ id: toastId, description: "Ctrl+Z restores everything." },
				);
			}
		} catch (e) {
			toast.error(`${label} failed`, {
				id: toastId,
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setBusy(null);
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="default"
					size="sm"
					className="gap-1.5 rounded-sm font-semibold data-[state=open]:bg-neutral-600 data-[state=open]:text-white"
					disabled={!!busy}
				>
					{busy ? (
						<>
							<Spinner className="size-3.5" /> {busy}...
						</>
					) : (
						<>
							<HugeiconsIcon icon={ScissorIcon} size={14} /> AI CUT
						</>
					)}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem
					onClick={() => void run("Remove silences", () => runRemoveSilences({ editor }))}
				>
					Remove silences
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() =>
						void run("Remove repeats", () =>
							runRemoveRepeats({
								editor,
								onProgress: (d) => toast.loading(d, { id: "ai-cut-progress" }),
							}).finally(() => toast.dismiss("ai-cut-progress")),
						)
					}
				>
					Remove repeats (retakes)
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() =>
						void run("Autocut", async () => {
							const r = await runAutocut({ editor });
							return { cuts: r.cuts, removedSec: r.removedSec };
						})
					}
				>
					Autocut (assemble + clean)
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
