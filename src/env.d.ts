declare global {
	interface Env {
		COGNITO_CLIENT_SECRET?: string;
		COGNITO_REDIRECT_URI?: string;
		SEARCH_SERVICE_URL?: string;
		MEETINGS_SERVICE_URL?: string;
	}
}

export {};
