'use strict';

const crypto = require('node:crypto');

const SCHEMA_RECORDS_SQL = `
WITH schema_records AS (
  SELECT
    'extension'::text AS record_type,
    extension_row.extname::text AS identity,
    ''::text AS definition
  FROM pg_extension extension_row
  JOIN pg_namespace extension_namespace
    ON extension_namespace.oid = extension_row.extnamespace
  WHERE extension_namespace.nspname = 'public'

  UNION ALL

  SELECT
    'relation',
    format('%I.%I', namespace_row.nspname, class_row.relname),
    concat_ws(',',
      'kind=' || class_row.relkind::text,
      'persistence=' || class_row.relpersistence::text,
      'rls=' || class_row.relrowsecurity::text,
      'force_rls=' || class_row.relforcerowsecurity::text,
      'partition=' || coalesce(pg_get_partkeydef(class_row.oid), ''),
      'view=' || CASE
        WHEN class_row.relkind IN ('v', 'm') THEN pg_get_viewdef(class_row.oid, true)
        ELSE ''
      END
    )
  FROM pg_class class_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND class_row.relkind IN ('r', 'p', 'S', 'v', 'm')
    AND class_row.relname <> 'cotsel_schema_migrations'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend dependency_row
      WHERE dependency_row.classid = 'pg_class'::regclass
        AND dependency_row.objid = class_row.oid
        AND dependency_row.deptype = 'e'
    )

  UNION ALL

  SELECT
    'column',
    format('%I.%I.%s', namespace_row.nspname, class_row.relname, attribute_row.attnum),
    concat_ws(',',
      'name=' || attribute_row.attname,
      'type=' || format_type(attribute_row.atttypid, attribute_row.atttypmod),
      'not_null=' || attribute_row.attnotnull::text,
      'default=' || coalesce(pg_get_expr(default_row.adbin, default_row.adrelid), ''),
      'identity=' || attribute_row.attidentity::text,
      'generated=' || attribute_row.attgenerated::text,
      'collation=' || coalesce(collation_namespace.nspname || '.' || collation_row.collname, '')
    )
  FROM pg_attribute attribute_row
  JOIN pg_class class_row ON class_row.oid = attribute_row.attrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
  LEFT JOIN pg_attrdef default_row
    ON default_row.adrelid = attribute_row.attrelid
   AND default_row.adnum = attribute_row.attnum
  LEFT JOIN pg_collation collation_row ON collation_row.oid = attribute_row.attcollation
  LEFT JOIN pg_namespace collation_namespace ON collation_namespace.oid = collation_row.collnamespace
  WHERE namespace_row.nspname = 'public'
    AND class_row.relkind IN ('r', 'p', 'v', 'm')
    AND class_row.relname <> 'cotsel_schema_migrations'
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped

  UNION ALL

  SELECT
    'constraint',
    format('%I.%I.%I', namespace_row.nspname, class_row.relname, constraint_row.conname),
    concat_ws(',',
      'type=' || constraint_row.contype::text,
      'definition=' || pg_get_constraintdef(constraint_row.oid, true)
    )
  FROM pg_constraint constraint_row
  JOIN pg_class class_row ON class_row.oid = constraint_row.conrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND class_row.relname <> 'cotsel_schema_migrations'

  UNION ALL

  SELECT
    'index',
    format('%I.%I', namespace_row.nspname, index_class.relname),
    pg_get_indexdef(index_row.indexrelid)
  FROM pg_index index_row
  JOIN pg_class table_class ON table_class.oid = index_row.indrelid
  JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = table_class.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND table_class.relname <> 'cotsel_schema_migrations'

  UNION ALL

  SELECT
    'policy',
    format('%I.%I.%I', namespace_row.nspname, class_row.relname, policy_row.polname),
    concat_ws(',',
      'command=' || policy_row.polcmd::text,
      'permissive=' || policy_row.polpermissive::text,
      'roles=' || coalesce((
        SELECT string_agg(role_row.rolname, ':' ORDER BY role_row.rolname)
        FROM pg_roles role_row
        WHERE role_row.oid = ANY(policy_row.polroles)
      ), ''),
      'using=' || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), ''),
      'check=' || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '')
    )
  FROM pg_policy policy_row
  JOIN pg_class class_row ON class_row.oid = policy_row.polrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND class_row.relname <> 'cotsel_schema_migrations'

  UNION ALL

  SELECT
    'function',
    format('%I.%I(%s)',
      namespace_row.nspname,
      procedure_row.proname,
      pg_get_function_identity_arguments(procedure_row.oid)
    ),
    pg_get_functiondef(procedure_row.oid)
  FROM pg_proc procedure_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = procedure_row.pronamespace
  WHERE namespace_row.nspname = 'public'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend dependency_row
      WHERE dependency_row.classid = 'pg_proc'::regclass
        AND dependency_row.objid = procedure_row.oid
        AND dependency_row.deptype = 'e'
    )

  UNION ALL

  SELECT
    'trigger',
    format('%I.%I.%I', namespace_row.nspname, class_row.relname, trigger_row.tgname),
    pg_get_triggerdef(trigger_row.oid, true)
  FROM pg_trigger trigger_row
  JOIN pg_class class_row ON class_row.oid = trigger_row.tgrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND class_row.relname <> 'cotsel_schema_migrations'
    AND NOT trigger_row.tgisinternal

  UNION ALL

  SELECT
    'type',
    format('%I.%I', namespace_row.nspname, type_row.typname),
    concat_ws(',',
      'kind=' || type_row.typtype::text,
      'base=' || CASE
        WHEN type_row.typbasetype = 0 THEN ''
        ELSE format_type(type_row.typbasetype, type_row.typtypmod)
      END,
      'not_null=' || type_row.typnotnull::text,
      'default=' || coalesce(type_row.typdefault, ''),
      'enum=' || coalesce((
        SELECT string_agg(enum_row.enumlabel, ':' ORDER BY enum_row.enumsortorder)
        FROM pg_enum enum_row
        WHERE enum_row.enumtypid = type_row.oid
      ), '')
    )
  FROM pg_type type_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
  WHERE namespace_row.nspname = 'public'
    AND type_row.typtype IN ('d', 'e', 'r', 'm')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend dependency_row
      WHERE dependency_row.classid = 'pg_type'::regclass
        AND dependency_row.objid = type_row.oid
        AND dependency_row.deptype = 'e'
    )

  UNION ALL

  SELECT
    'sequence',
    format('%I.%I', namespace_row.nspname, class_row.relname),
    concat_ws(',',
      'type=' || format_type(sequence_row.seqtypid, NULL),
      'start=' || sequence_row.seqstart::text,
      'increment=' || sequence_row.seqincrement::text,
      'minimum=' || sequence_row.seqmin::text,
      'maximum=' || sequence_row.seqmax::text,
      'cache=' || sequence_row.seqcache::text,
      'cycle=' || sequence_row.seqcycle::text
    )
  FROM pg_sequence sequence_row
  JOIN pg_class class_row ON class_row.oid = sequence_row.seqrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
  WHERE namespace_row.nspname = 'public'
)
SELECT record_type, identity, definition
FROM schema_records
ORDER BY record_type, identity, definition
`;

async function computePublicSchemaFingerprint(client) {
  const result = await client.query({ text: SCHEMA_RECORDS_SQL, rowMode: 'array' });
  return crypto.createHash('sha256').update(JSON.stringify(result.rows)).digest('hex');
}

module.exports = { computePublicSchemaFingerprint, SCHEMA_RECORDS_SQL };
