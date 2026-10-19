-- ---------------------------------------------------------------------------
-- Admin views of a group are no longer audited.
--
-- GET /groups/:id used to write a `group.adminView` row whenever a parish admin
-- opened a Private or Secret group they were not in. That logging is gone, and
-- the action has no label any more (api/src/types.ts), so the rows it left
-- behind would list under their raw action string. Removed rather than kept.
-- ---------------------------------------------------------------------------
delete from audit_log where action = 'group.adminView';
