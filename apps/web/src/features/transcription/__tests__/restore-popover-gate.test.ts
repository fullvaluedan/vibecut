import { describe, expect, test } from "bun:test";
import { canRestoreDeletion } from "../restore-popover-gate";

describe("canRestoreDeletion", () => {
	test("restorable: the deletion is still the top of the undo stack", () => {
		const command = { id: "delete-1" };
		expect(
			canRestoreDeletion({ deletionCommand: command, topUndoCommand: command }),
		).toBe(true);
	});

	test("not restorable: a later command sits on top of the stack", () => {
		const deletion = { id: "delete-1" };
		const later = { id: "delete-2" };
		expect(
			canRestoreDeletion({ deletionCommand: deletion, topUndoCommand: later }),
		).toBe(false);
	});

	test("not restorable: the stack is empty (top is null)", () => {
		const deletion = { id: "delete-1" };
		expect(
			canRestoreDeletion({ deletionCommand: deletion, topUndoCommand: null }),
		).toBe(false);
	});

	test("not restorable: this record never captured a command", () => {
		const top = { id: "delete-1" };
		expect(
			canRestoreDeletion({ deletionCommand: null, topUndoCommand: top }),
		).toBe(false);
	});

	test("not restorable: both null", () => {
		expect(
			canRestoreDeletion({ deletionCommand: null, topUndoCommand: null }),
		).toBe(false);
	});
});
