/**
 * The real transport for one assistant turn (T17.2): POST to
 * `/api/assistant/edit` with the device-local AI auth headers.
 *
 * Kept OUT of `turn-service.ts` on purpose. The service is the state machine
 * and must stay free of the ai-settings zustand store, so its tests can drive
 * it with a stub transport and never go near `fetch`, a store, or a key. This
 * file is the one place that knows the URL and the headers.
 */

import { buildAiAuthHeaders } from "@/features/ai-generate/store";
import type { AssistantTurnRequest, AssistantTurnResponse } from "./types";
import type { AssistantTurnTransport } from "./turn-service";

export const ASSISTANT_EDIT_ENDPOINT = "/api/assistant/edit";

/**
 * The route answers with either an `AssistantTurnResponse` or `{ error }`. An
 * error is thrown rather than returned, because the driver already funnels
 * every throw into one `error` event with the message intact - and the route's
 * messages are written to be read by a person (see the Groq-key precedent from
 * T16.3: an actionable sentence beats a status code).
 */
export const postAssistantTurn: AssistantTurnTransport = async (
	request: AssistantTurnRequest,
): Promise<AssistantTurnResponse> => {
	const response = await fetch(ASSISTANT_EDIT_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json", ...buildAiAuthHeaders("assistant") },
		body: JSON.stringify(request),
	});
	const data = (await response.json().catch(() => null)) as
		| (AssistantTurnResponse & { error?: string })
		| null;
	if (!response.ok || !data) {
		throw new Error(
			data?.error ?? `The assistant could not be reached (${response.status}).`,
		);
	}
	if (data.error) throw new Error(data.error);
	return data;
};
