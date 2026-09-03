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

/** Task models answer with JSON; providers like to wrap it in prose or fences. */
export function extractJSON<T = Record<string, unknown>>(text: string): T | null {
	if (!text) return null;
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const candidate = fenced ? fenced[1] : text;
	const start = candidate.indexOf('{');
	const end = candidate.lastIndexOf('}');
	if (start === -1 || end === -1 || end < start) return null;
	try {
		return JSON.parse(candidate.slice(start, end + 1)) as T;
	} catch {
		return null;
	}
}
