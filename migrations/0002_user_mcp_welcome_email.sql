CREATE TABLE IF NOT EXISTS user_mcp_welcome (
	user_id TEXT PRIMARY KEY,
	welcome_email_sent_at INTEGER,
	welcome_email_in_flight_at INTEGER
);
