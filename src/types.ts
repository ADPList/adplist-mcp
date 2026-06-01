import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type Bindings = Env & {
	OAUTH_PROVIDER: OAuthHelpers;
};

export type StoredLogin = {
	oauthReqInfo: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>;
	clientName?: string;
	createdAt: number;
	email?: string;
	cognitoSession?: string;
	cognitoUserId?: string;
};

export type StoredRevoke = {
	createdAt: number;
	email: string;
	cognitoSession: string;
	cognitoUserId: string;
};

export type McpUserProps = {
	userId: string;
	email: string | null;
	scopes: string[];
	mcpClientId?: string;
	cognitoAccessToken?: string;
	cognitoAccessTokenExpiresAt?: number;
	cognitoAccessTokenRefreshedAt?: number;
	adplistRefreshToken?: string;
};
