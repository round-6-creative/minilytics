-- Cookieless sites: visitor ids are a hash of a random salt, the IP and the user agent. The salt is replaced every
-- UTC day and the old one deleted, so nobody (including us) can link a visitor across days or recover an IP.
CREATE TABLE daily_salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);
