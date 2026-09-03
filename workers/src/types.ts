/** Bindings and per-request context shared by every route module. */

export interface Env {
	// Storage
	DB: D1Database;
	CACHE: KVNamespace;
	FILES: R2Bucket;

	// Realtime hub
	SOCKET: DurableObjectNamespace;

	// Optional platform services
	AI?: Ai;
	VECTORIZE?: VectorizeIndex;
	ASSETS?: Fetcher;

	// Vars / secrets
	WEBUI_NAME?: string;
	WEBUI_URL?: string;
	WEBUI_SECRET_KEY?: string;
	WEBUI_AUTH?: string;
	CORS_ALLOW_ORIGIN?: string;
	ENABLE_SIGNUP?: string;
	ENABLE_LOGIN_FORM?: string;
	DEFAULT_USER_ROLE?: string;
	DEFAULT_MODELS?: string;
	ENABLE_WORKERS_AI?: string;
	WORKERS_AI_MODELS?: string;
	NVIDIA_API_KEY?: string;
	NVIDIA_API_BASE_URL?: string;
	NVIDIA_MODELS?: string;
	ENABLE_NVIDIA_API?: string;
	OPENAI_API_KEY?: string;
	OPENAI_API_KEYS?: string;
	OPENAI_API_BASE_URL?: string;
	OPENAI_API_BASE_URLS?: string;
	ENABLE_OPENAI_API?: string;
	JWT_EXPIRES_IN?: string;
	WEB_SEARCH_API_KEY?: string;
	WEB_SEARCH_URL?: string;
	RAG_EMBEDDING_MODEL?: string;
	TASK_MODEL?: string;
}

export interface SessionUser {
	id: string;
	email: string;
	name: string;
	role: string;
	profile_image_url: string | null;
	bio: string | null;
	gender: string | null;
	date_of_birth: string | null;
	timezone: string | null;
	status_emoji: string | null;
	status_message: string | null;
	status_expires_at: number | null;
	info: Record<string, unknown> | null;
	settings: Record<string, unknown> | null;
	variables: Record<string, unknown>;
	last_active_at: number;
	updated_at: number;
	created_at: number;
}

export type Variables = {
	user: SessionUser | null;
	token: string | null;
};

export type AppContext = { Bindings: Env; Variables: Variables };
