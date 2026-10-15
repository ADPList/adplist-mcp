declare global {
	interface Env {
		AUTH_SERVICE_URL?: string;
		IDENTITY_INTERNAL_API_KEY?: string;
		SEARCH_SERVICE_URL?: string;
		MEETINGS_SERVICE_URL?: string;
		SENDGRID_API_KEY?: string;
		WELCOME_EMAIL_GIF_URL?: string;
		WELCOME_EMAIL_FROM_EMAIL?: string;
		WELCOME_EMAIL_FROM_NAME?: string;
		ASSETS?: Fetcher;
		// Public no-login tier (ADPLIST-4479).
		PUBLIC_OPT_OUT_SLUGS?: string;
		PUBLIC_RATE_LIMITER?: RateLimit;
		// Strict per-IP limit: PublicRateLimiter Durable Object.
		PUBLIC_RATE_LIMIT_DO?: DurableObjectNamespace;
		AMPLITUDE_API_KEY?: string;
	}
}

export {};
