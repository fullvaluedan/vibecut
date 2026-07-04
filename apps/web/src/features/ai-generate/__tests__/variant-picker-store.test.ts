import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	useVariantPickerStore,
	buildVersionPlacements,
} from "../variant-picker-store";
import type { AuthoredVersion } from "../run-hyperframes-scoped";

// bun has no DOM, so URL.createObjectURL/revokeObjectURL are unimplemented.
// Stub them, recording calls, so the store's object-URL lifecycle is observable.
const created: File[] = [];
const revoked: string[] = [];
let seq = 0;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

beforeEach(() => {
	created.length = 0;
	revoked.length = 0;
	seq = 0;
	URL.createObjectURL = (f: Blob) => {
		created.push(f as File);
		return `blob:mock/${seq++}`;
	};
	URL.revokeObjectURL = (u: string) => {
		revoked.push(u);
	};
	useVariantPickerStore.setState({
		versions: null,
		isOpen: false,
		urls: new Map(),
	});
});

afterEach(() => {
	URL.createObjectURL = realCreate;
	URL.revokeObjectURL = realRevoke;
});

function version(index: number, fileCount: number): AuthoredVersion {
	return {
		index,
		angle: `angle ${index}`,
		renders: Array.from({ length: fileCount }, (_, i) => ({
			file: new File([`v${index}-${i}`], `hf-${index}-${i}.webm`, {
				type: "video/webm",
			}),
			chunk: { index: i, label: `${i}:00`, startSec: i * 10, endSec: i * 10 + 10 },
			// render 0 has no compId (exercises the templateId fallback); later ones do.
			compId: i === 0 ? undefined : `comp-${index}-${i}`,
			brief: `brief ${index}-${i}`,
		})),
		skipped: [],
	};
}

describe("useVariantPickerStore — draft lifecycle + object-URL hygiene", () => {
	test("open() stores versions, opens, and creates one URL per render file", () => {
		const v = [version(0, 2), version(1, 1)]; // 3 render files total
		useVariantPickerStore.getState().open(v);
		const s = useVariantPickerStore.getState();
		expect(s.versions).toBe(v);
		expect(s.isOpen).toBe(true);
		expect(s.urls.size).toBe(3);
		expect(created.length).toBe(3);
	});

	test("open() again revokes the previous URL set before rebuilding", () => {
		useVariantPickerStore.getState().open([version(0, 2)]);
		expect(revoked.length).toBe(0);
		useVariantPickerStore.getState().open([version(1, 1)]);
		expect(revoked.length).toBe(2); // the first set's two URLs
		expect(useVariantPickerStore.getState().urls.size).toBe(1);
	});

	test("close() hides the modal but KEEPS versions + URLs (the whole point)", () => {
		const v = [version(0, 1)];
		useVariantPickerStore.getState().open(v);
		useVariantPickerStore.getState().close();
		const s = useVariantPickerStore.getState();
		expect(s.isOpen).toBe(false);
		expect(s.versions).toBe(v);
		expect(s.urls.size).toBe(1);
		expect(revoked.length).toBe(0); // not revoked on close
	});

	test("discard() clears versions and revokes every URL (the only destructive exit)", () => {
		useVariantPickerStore.getState().open([version(0, 2)]);
		useVariantPickerStore.getState().discard();
		const s = useVariantPickerStore.getState();
		expect(s.versions).toBeNull();
		expect(s.urls.size).toBe(0);
		expect(s.isOpen).toBe(false);
		expect(revoked.length).toBe(2);
	});

	test("show() is a no-op with no drafts, and reopens retained drafts", () => {
		useVariantPickerStore.getState().show();
		expect(useVariantPickerStore.getState().isOpen).toBe(false);
		useVariantPickerStore.getState().open([version(0, 1)]);
		useVariantPickerStore.getState().close();
		useVariantPickerStore.getState().show();
		expect(useVariantPickerStore.getState().isOpen).toBe(true);
		expect(useVariantPickerStore.getState().versions).not.toBeNull();
	});
});

describe("buildVersionPlacements — apply mapping (one new-track entry per render)", () => {
	test("maps each render with the authored: templateId fallback", () => {
		const out = buildVersionPlacements(version(3, 2));
		expect(out.length).toBe(2);
		// render 0: no compId -> templateId falls back to the chunk index
		expect(out[0].compId).toBeUndefined();
		expect(out[0].templateId).toBe("authored:0");
		expect(out[0].startSec).toBe(0);
		expect(out[0].name).toBe("HyperFrames: 0:00");
		// render 1: compId present -> templateId uses it
		expect(out[1].compId).toBe("comp-3-1");
		expect(out[1].templateId).toBe("authored:comp-3-1");
		expect(out[1].startSec).toBe(10);
		expect(out[1].brief).toBe("brief 3-1");
	});

	test("an empty version yields no placements", () => {
		expect(buildVersionPlacements(version(0, 0))).toEqual([]);
	});
});
