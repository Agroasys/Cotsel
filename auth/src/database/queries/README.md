# Auth database query modules

`../queries.ts` is the stable public export surface for Auth database queries. Keep new
callers on that barrel unless they are implementing another query module in this directory.

- `sessionNormalization.ts` converts database session rows into the domain session shape.
- `sessions.ts` owns session persistence and revocation queries.
- `profileRows.ts` contains shared profile-row SQL and locking primitives.
- `profiles.ts` owns the public profile lookup and mutation operations.
- `adminAudit.ts` owns audited administrative profile operations and audit-event reads.
- `breakGlass.ts` owns the grant, review, and revocation transaction boundaries.

The split is organizational only. SQL statements, transaction boundaries, parameter order,
and the exports from `../queries.ts` are compatibility-sensitive and require focused tests
when changed.
