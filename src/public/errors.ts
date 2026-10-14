// Public-tier errors (ADPLIST-4479). Fixed code, fixed message, nothing else:
// no details, cause, upstream body, stack, URL, or validation text. Anything
// that is not a PublicError is reported as UNAVAILABLE.
export type PublicErrorCode = "NOT_FOUND" | "INVALID_INPUT" | "RATE_LIMITED" | "UNAVAILABLE";

export const PUBLIC_ERROR_MESSAGES: Record<PublicErrorCode, string> = {
	NOT_FOUND: "No public ADPList mentor profile matches that request.",
	INVALID_INPUT: "The request input is invalid.",
	RATE_LIMITED: "Too many requests. Try again in a minute.",
	UNAVAILABLE: "ADPList mentor search is temporarily unavailable.",
};

export class PublicError extends Error {
	readonly code: PublicErrorCode;
	constructor(code: PublicErrorCode) {
		super(PUBLIC_ERROR_MESSAGES[code]);
		this.name = "PublicError";
		this.code = code;
	}
}

export type PublicErrorBody = {
	error: { code: PublicErrorCode; message: string };
};

export function publicErrorCode(error: unknown): PublicErrorCode {
	return error instanceof PublicError ? error.code : "UNAVAILABLE";
}

export function formatPublicError(error: unknown): PublicErrorBody {
	const code = publicErrorCode(error);
	return { error: { code, message: PUBLIC_ERROR_MESSAGES[code] } };
}
