/** Prompt templates for the background task models (title, tags, follow-ups). */

export const TITLE_GENERATION_PROMPT = `### Task:
Generate a concise title summarizing the chat history.
### Guidelines:
- The title should clearly represent the main theme or subject of the conversation.
- Keep it short: 2-4 words is best.
- Do not use emojis, quotation marks, or special formatting.
- Write the title in the chat's primary language; default to English if multilingual.
- Prioritize accuracy over creativity.
- Your entire response must consist solely of the JSON object, without any introductory or concluding text.
- The output must be a single, raw JSON object, without any markdown code fences or other encapsulating text.
### Output:
JSON format: { "title": "your concise title here" }
### Chat History:
<chat_history>
{{MESSAGES}}
</chat_history>`;

export const TAGS_GENERATION_PROMPT = `### Task:
Generate 1-3 broad tags categorizing the main themes of the chat history, along with 1-3 more specific subtopic tags.

### Guidelines:
- Start with high-level domains (e.g. Science, Technology, Philosophy, Arts, Politics, Business, Health, Sports, Entertainment, Education)
- Consider including relevant subfields/subdomains if they are strongly represented throughout the conversation
- If content is too short (less than 3 messages) or too diverse, use only ["General"]
- Use the chat's primary language; default to English if multilingual
- Prioritize accuracy over specificity
- Your entire response must consist solely of the JSON object.

### Output:
JSON format: { "tags": ["tag1", "tag2", "tag3"] }

### Chat History:
<chat_history>
{{MESSAGES}}
</chat_history>`;

export const FOLLOW_UP_GENERATION_PROMPT = `### Task:
Suggest 3-5 relevant follow-up questions or prompts that the user might naturally ask next, based on the chat history.

### Guidelines:
- Write all follow-up questions from the user's point of view, directed to the assistant.
- Match the conversation's tone and the user's language.
- Keep each suggestion under 12 words.
- Your entire response must consist solely of the JSON object.

### Output:
JSON format: { "follow_ups": ["Question 1?", "Question 2?", "Question 3?"] }

### Chat History:
<chat_history>
{{MESSAGES}}
</chat_history>`;

export const RAG_TEMPLATE = `### Task:
Respond to the user query using the provided context.

### Context:
<context>
{{CONTEXT}}
</context>

### User Query:
{{QUERY}}`;

/** Renders the `{{MESSAGES}}` placeholder from the tail of a conversation. */
export function renderMessages(
	messages: { role: string; content: unknown }[],
	limit: number
): string {
	return messages
		.slice(-limit)
		.map((message) => {
			const content =
				typeof message.content === 'string'
					? message.content
					: Array.isArray(message.content)
						? (message.content as any[])
								.map((part) => (typeof part?.text === 'string' ? part.text : ''))
								.join(' ')
						: '';
			return `${String(message.role).toUpperCase()}: ${content}`;
		})
		.join('\n');
}

/**
 * Removes a reasoning model's thinking from its answer.
 *
 * Providers disagree about where thinking goes. Some return it in a separate
 * `reasoning_content` field, which never reaches here; others leave it inline
 * in the content, wrapped in `<think>`. The second kind broke every background
 * task, because a model reasoning about JSON writes JSON while it reasons —
 * scanning from the first `{` to the last `}` then spans the draft, the prose
 * between, and the real answer.
 *
 * An unterminated block is stripped to the end of the text: that is what a
 * thought cut off by the token budget looks like, and keeping it would only
 * feed the parser the same braces.
 */
export function stripThinking(text: string): string {
	if (!text) return '';
	return text
		.replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
		.replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*$/i, '')
		.trim();
}

/** Every balanced `{…}` in the text, outermost first, in the order they start. */
function jsonCandidates(text: string): string[] {
	const found: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === '{') {
			if (depth === 0) start = i;
			depth += 1;
		} else if (char === '}' && depth > 0) {
			depth -= 1;
			if (depth === 0) found.push(text.slice(start, i + 1));
		}
	}
	return found;
}

/**
 * Task models answer with JSON; providers like to wrap it in prose or fences,
 * and reasoning models like to draft it aloud first.
 *
 * `wanted` names the key the caller is after. When several JSON objects survive
 * the thinking strip, the last one carrying that key wins — a model that
 * reconsiders states its final answer last, so that is the one it meant.
 */
export function extractJSON<T = Record<string, unknown>>(text: string, wanted?: string): T | null {
	if (!text) return null;
	const cleaned = stripThinking(text);
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
	const candidates = jsonCandidates(fenced ? fenced[1] : cleaned);

	let fallback: T | null = null;
	for (const candidate of candidates) {
		let parsed: T;
		try {
			parsed = JSON.parse(candidate) as T;
		} catch {
			continue;
		}
		if (!wanted) fallback = parsed;
		else if ((parsed as Record<string, unknown>)?.[wanted] !== undefined) fallback = parsed;
	}
	return fallback;
}
