-- Separate contact leads from pilot approvals and research participants.
-- 035–044 are reserved by the private security candidate; no renumbering here.
CREATE TABLE contact_interest (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
    handle TEXT CHECK (handle IS NULL OR length(handle) BETWEEN 1 AND 253),
    interests TEXT[] NOT NULL CHECK (cardinality(interests) BETWEEN 1 AND 4 AND interests <@ ARRAY['use','build','research','updates']::text[]),
    note TEXT CHECK (note IS NULL OR length(note) <= 500),
    consent_version TEXT NOT NULL CHECK (consent_version = 'contact-interest-v1'),
    consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
