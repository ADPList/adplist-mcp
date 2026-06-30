declare global {
	interface Env {
		AUTH_SERVICE_URL?: string;
		SEARCH_SERVICE_URL?: string;
		MEETINGS_SERVICE_URL?: string;
		SENDGRID_API_KEY?: string;
		WELCOME_EMAIL_GIF_URL?: string;
	}
}

export {};
