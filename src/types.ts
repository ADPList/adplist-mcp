import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type Bindings = Env & {
	OAUTH_PROVIDER: OAuthHelpers;
};

export type CognitoTokenResponse = {
	access_token: string;
	id_token?: string;
	refresh_token?: string;
	expires_in?: number;
	token_type: "Bearer" | string;
	scope?: string;
};

export type CognitoUserInfo = {
	sub: string;
	email?: string;
	username?: string;
	name?: string;
};

export type StoredOAuthRequest = {
	oauthReqInfo: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>;
	createdAt: number;
};

export type PendingConsent = StoredOAuthRequest & {
	tokens: CognitoTokenResponse;
	userInfo: CognitoUserInfo;
};

export type McpUserProps = {
	userId: string;
	email: string | null;
	scopes: string[];
	cognitoRefreshTokenKey?: string;
	cognitoAccessToken?: string;
};
