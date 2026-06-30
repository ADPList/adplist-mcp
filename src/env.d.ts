declare global {
	interface Env {
		AUTH_SERVICE_URL?: string;
		SEARCH_SERVICE_URL?: string;
		MEETINGS_SERVICE_URL?: string;
		SENDGRID_API_KEY?: string;
		WELCOME_EMAIL_GIF_URL?: string;
		WELCOME_EMAIL_FROM_EMAIL?: string;
		WELCOME_EMAIL_FROM_NAME?: string;
		ASSETS?: Fetcher;
	}
}

export {};
