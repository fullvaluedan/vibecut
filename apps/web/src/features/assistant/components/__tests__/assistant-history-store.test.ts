import { beforeEach, describe, expect, test } from "bun:test";
import {
	ASSISTANT_HISTORY_VERSION,
	MAX_MESSAGES_PER_PROJECT,
	clearAssistantHistory,
	readAssistantHistory,
	readAssistantHistoryStore,
	resetAssistantHistoryStorageForTests,
	writeAssistantHistory,
	writeAssistantHistoryRecord,
} from "../assistant-history-store";
import type { AssistantMessage } from "../assistant-reducer";

const NOW = 1_700_000_000_000;

function makeMessages(n: number, projectId = "p1"): AssistantMessage[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `${projectId}-m${i}`,
		role: i % 2 === 0 ? "user" : "assistant",
		kind: "text",
		text: `message ${i}`,
		createdAt: NOW + i,
	}));
}

beforeEach(() => {
	resetAssistantHistoryStorageForTests();
});

describe("round-trip", () => {
	test("writes then reads back the same messages for a project", () => {
		const messages = makeMessages(3);
		writeAssistantHistory({ projectId: "p1", messages, now: NOW });
		expect(readAssistantHistory("p1")).toEqual(messages);
	});

	test("an unknown project reads back an empty list", () => {
		expect(readAssistantHistory("never-written")).toEqual([]);
	});

	test("undo callbacks do not survive the round-trip", () => {
		const messages: AssistantMessage[] = [
			{
				id: "m1",
				role: "system-status",
				kind: "applied",
				text: "Applied: 1 change",
				createdAt: NOW,
				appliedCount: 1,
				undo: () => {},
			},
		];
		writeAssistantHistory({ projectId: "p1", messages, now: NOW });
		const read = readAssistantHistory("p1");
		expect(read).toHaveLength(1);
		expect("undo" in read[0]).toBe(false);
		expect(read[0]).toMatchObject({ kind: "applied", appliedCount: 1 });
	});

	test("round-trips through JSON.stringify/parse the way real storage does", () => {
		const messages = makeMessages(2);
		writeAssistantHistory({ projectId: "p1", messages, now: NOW });
		const store = readAssistantHistoryStore();
		expect(JSON.parse(JSON.stringify(store))).toEqual(store);
	});
});

describe("cap", () => {
	test("caps a project's history to MAX_MESSAGES_PER_PROJECT, keeping the newest", () => {
		const messages = makeMessages(MAX_MESSAGES_PER_PROJECT + 25);
		writeAssistantHistory({ projectId: "p1", messages, now: NOW });
		const read = readAssistantHistory("p1");
		expect(read).toHaveLength(MAX_MESSAGES_PER_PROJECT);
		expect(read[0].id).toBe(`p1-m25`);
		expect(read[read.length - 1].id).toBe(`p1-m${MAX_MESSAGES_PER_PROJECT + 24}`);
	});

	test("a re-write with fewer messages does not resurrect earlier-capped ones", () => {
		writeAssistantHistory({ projectId: "p1", messages: makeMessages(5), now: NOW });
		writeAssistantHistory({ projectId: "p1", messages: makeMessages(2), now: NOW + 1 });
		expect(readAssistantHistory("p1")).toHaveLength(2);
	});
});

describe("versioning", () => {
	test("a record written on an older version is discarded, not mis-read", () => {
		writeAssistantHistoryRecord({
			version: ASSISTANT_HISTORY_VERSION - 1,
			projectId: "p1",
			updatedAt: NOW,
			messages: makeMessages(1),
		});
		expect(readAssistantHistory("p1")).toEqual([]);
	});
});

describe("cross-project LRU", () => {
	test("keeps at most 10 projects, evicting the least recently updated first", () => {
		for (let i = 0; i < 12; i++) {
			writeAssistantHistory({
				projectId: `proj-${i}`,
				messages: makeMessages(1, `proj-${i}`),
				now: NOW + i,
			});
		}
		const store = readAssistantHistoryStore();
		expect(Object.keys(store)).toHaveLength(10);
		expect(store["proj-0"]).toBeUndefined();
		expect(store["proj-1"]).toBeUndefined();
		expect(store["proj-11"]).toBeDefined();
	});
});

describe("clearAssistantHistory", () => {
	test("removes one project's history without touching others", () => {
		writeAssistantHistory({ projectId: "p1", messages: makeMessages(1), now: NOW });
		writeAssistantHistory({ projectId: "p2", messages: makeMessages(1, "p2"), now: NOW });
		clearAssistantHistory("p1");
		expect(readAssistantHistory("p1")).toEqual([]);
		expect(readAssistantHistory("p2")).toHaveLength(1);
	});
});
