"use client";

import { useMemo } from "react";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import {
	ACTIONS,
	isActionWithOptionalArgs,
	type TActionWithOptionalArgs,
} from "@/actions";
import {
	getPlatformAlternateKey,
	getPlatformSpecialKey,
} from "@/utils/platform";

export interface KeyboardShortcut {
	id: string;
	keys: string[];
	description: string;
	category: string;
	action: TActionWithOptionalArgs;
	icon?: React.ReactNode;
}

export function formatKey({ key }: { key: string }): string {
	// NOTE: combos already use "+" as their separator (e.g. "ctrl+c"), so the
	// per-token replacements below leave it intact. We do NOT rewrite "-" to
	// "+": "-" is the literal zoom-out key, and rewriting it produced an empty
	// two-chip render once `split("+")` ran over it.
	return key
		.replace("ctrl", getPlatformSpecialKey())
		.replace("alt", getPlatformAlternateKey())
		.replace("shift", "Shift")
		.replace("left", "←")
		.replace("right", "→")
		.replace("up", "↑")
		.replace("down", "↓")
		.replace("space", "Space")
		.replace("home", "Home")
		.replace("enter", "Enter")
		.replace("end", "End")
		.replace("delete", "Delete")
		.replace("backspace", "Backspace");
}

export function useKeyboardShortcutsHelp() {
	const { keybindings } = useKeybindingsStore();

	const shortcuts = useMemo(() => {
		// Seed EVERY invokable action so unbound ones (e.g. stop-playback,
		// toggle-ripple-editing) still appear in the editor as "Not set" and can
		// be assigned a key — the editor was previously built from bound keys
		// only, hiding actions that ship without a default shortcut. The
		// asset-removal actions need a payload and can't be invoked from a bare
		// hotkey, so they're excluded.
		const actionToKeys = new Map<TActionWithOptionalArgs, string[]>();
		for (const action of Object.keys(ACTIONS)) {
			if (isActionWithOptionalArgs(action)) {
				actionToKeys.set(action, []);
			}
		}

		for (const [key, action] of keybindings) {
			const existing = actionToKeys.get(action);
			if (existing) {
				existing.push(formatKey({ key }));
			} else {
				actionToKeys.set(action, [formatKey({ key })]);
			}
		}

		const result: KeyboardShortcut[] = [];
		for (const [action, keys] of actionToKeys) {
			const actionDef = ACTIONS[action];
			if (!actionDef) continue;
			result.push({
				id: action,
				keys,
				description: actionDef.description,
				category: actionDef.category,
				action,
			});
		}

		return result.sort((a, b) => {
			if (a.category !== b.category) {
				return a.category.localeCompare(b.category);
			}
			return a.description.localeCompare(b.description);
		});
	}, [keybindings]);

	return {
		shortcuts,
	};
}
