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
	OLLAMA_API_KEY?: string;
	OLLAMA_API_KEYS?: string;
	OLLAMA_BASE_URL?: string;
	ENABLE_OPENAI_API?: string;
	JWT_EXPIRES_IN?: string;
	WEB_SEARCH_API_KEY?: string;
	WEB_SEARCH_URL?: string;
	RAG_EMBEDDING_MODEL?: string;
	TASK_MODEL?: string;

	// OAuth / OIDC. The generic `oidc` client is also editable in Admin
	// Settings; the named providers are env-only, matching upstream.
	ENABLE_OAUTH?: string;
	OAUTH_CLIENT_ID?: string;
	OAUTH_CLIENT_SECRET?: string;
	OPENID_PROVIDER_URL?: string;
	OPENID_REDIRECT_URI?: string;
	OAUTH_PROVIDER_NAME?: string;
	OAUTH_SCOPES?: string;
	OAUTH_EMAIL_CLAIM?: string;
	OAUTH_USERNAME_CLAIM?: string;
	OAUTH_PICTURE_CLAIM?: string;
	OAUTH_SUB_CLAIM?: string;
	OAUTH_GROUPS_CLAIM?: string;
	OAUTH_ROLES_CLAIM?: string;
	ENABLE_OAUTH_SIGNUP?: string;
	OAUTH_MERGE_ACCOUNTS_BY_EMAIL?: string;
	OAUTH_AUTO_REDIRECT?: string;
	OAUTH_ALLOWED_DOMAINS?: string;
	ENABLE_OAUTH_ROLE_MANAGEMENT?: string;
	ENABLE_OAUTH_GROUP_MANAGEMENT?: string;
	ENABLE_OAUTH_GROUP_CREATION?: string;
	OAUTH_ALLOWED_ROLES?: string;
	OAUTH_ADMIN_ROLES?: string;
	OAUTH_BLOCKED_GROUPS?: string;
	OAUTH_UPDATE_NAME_ON_LOGIN?: string;
	OAUTH_UPDATE_EMAIL_ON_LOGIN?: string;
	OAUTH_UPDATE_PICTURE_ON_LOGIN?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GOOGLE_OAUTH_SCOPE?: string;
	GOOGLE_REDIRECT_URI?: string;
	MICROSOFT_CLIENT_ID?: string;
	MICROSOFT_CLIENT_SECRET?: string;
	MICROSOFT_CLIENT_TENANT_ID?: string;
	MICROSOFT_CLIENT_LOGIN_BASE_URL?: string;
	MICROSOFT_OAUTH_SCOPE?: string;
	MICROSOFT_REDIRECT_URI?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	GITHUB_CLIENT_SCOPE?: string;
	GITHUB_CLIENT_REDIRECT_URI?: string;
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
