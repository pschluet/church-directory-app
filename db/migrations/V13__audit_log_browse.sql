-- The audit log gets a page, so it now has to be read as well as written.
--
-- Reading it means keyset pagination over one parish, newest first, which needs
-- `id` on the end of the index: `created_at` is not unique -- the merge paths in
-- routes/merges.ts write two rows inside one transaction, at the same instant --
-- so the cursor compares `(created_at, id)` and the ordering has to match, or
-- every page costs a sort of the parish's whole history.
--
-- The old index is a strict prefix of this one and buys nothing once it exists.
create index audit_log_org_created_id_idx
  on audit_log (organization_id, created_at desc, id desc);

drop index audit_log_org_created_idx;

-- Deliberately no index for the action, entity type and actor filters. They run
-- as predicates on top of the ordered scan above, which has already narrowed to
-- one parish -- the same reasoning routes/directory.ts gives for searching every
-- field with a plain ILIKE: a parish is hundreds of people, and there is no
-- scale here that would justify three more indexes on every write. If one
-- organization ever passes a million rows, (organization_id, actor_app_user_id,
-- created_at desc, id desc) and its `action` twin are the two to add.
--
-- And deliberately no CHECK on `action` or `entity_type`, though every other
-- enum in this schema has one. `audit()` swallows its own errors so that a
-- failed audit write can never fail somebody's save, which means a CHECK
-- violation here would not be a loud deploy failure -- it would silently stop
-- recording whichever action was added without touching this file. A label that
-- has drifted is a far cheaper wrong than a hole in the trail, so the read path
-- takes its filter options from the rows themselves instead.
