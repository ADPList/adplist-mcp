CREATE TABLE IF NOT EXISTS user_mcp_profile (
	user_id TEXT PRIMARY KEY,
	profile_json TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
