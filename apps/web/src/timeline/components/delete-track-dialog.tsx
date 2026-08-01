"use client";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/**
 * T15.4 track management: confirm before deleting a track that still holds
 * clips ("Delete track and N clips?"). A track with zero elements deletes
 * without this dialog (nothing to lose). One RemoveTrackCommand covers the
 * track + every element on it, so this only ever gates a SINGLE undoable
 * command, never a batch.
 */
export function DeleteTrackDialog({
	isOpen,
	onOpenChange,
	onConfirm,
	elementCount,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	elementCount: number;
}) {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				<DialogHeader>
					<DialogTitle>
						{`Delete track and ${elementCount} ${elementCount === 1 ? "clip" : "clips"}?`}
					</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<p className="text-muted-foreground text-sm">
						This removes the track and everything on it. You can undo with
						Ctrl+Z / Cmd+Z.
					</p>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={() => {
							onConfirm();
							onOpenChange(false);
						}}
					>
						Delete track
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
