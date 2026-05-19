declare global {
	interface Env {
		COGNITO_CLIENT_SECRET?: string;
		COGNITO_REDIRECT_URI?: string;
	}
}

export {};
