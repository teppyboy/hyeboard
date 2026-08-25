CREATE TABLE hyeboard_feature_policy_current (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  snapshot jsonb NOT NULL CHECK ((jsonb_typeof(snapshot) = 'object') IS TRUE)
);

CREATE TABLE hyeboard_feature_policy_history (
  revision bigint PRIMARY KEY CHECK (revision BETWEEN 1 AND 9007199254740991),
  base_revision bigint NOT NULL CHECK (base_revision = revision - 1),
  actor jsonb NOT NULL CHECK ((jsonb_typeof(actor) = 'object') IS TRUE),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)),
  published_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK ((jsonb_typeof(snapshot) = 'object') IS TRUE)
);

CREATE FUNCTION hyeboard_reject_feature_policy_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'feature policy history is immutable';
END;
$$;

CREATE TRIGGER hyeboard_feature_policy_history_immutable
BEFORE UPDATE OR DELETE ON hyeboard_feature_policy_history
FOR EACH ROW EXECUTE FUNCTION hyeboard_reject_feature_policy_history_mutation();

INSERT INTO hyeboard_feature_policy_current (singleton, revision, snapshot)
VALUES (true, 0, '{"revision":0,"global":{"capabilities":{},"limits":{}},"universities":{}}'::jsonb)
ON CONFLICT (singleton) DO NOTHING;
