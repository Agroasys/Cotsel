# Dashboard Gateway OpenAPI Source

This directory is the editable source for the Cotsel Dashboard Gateway OpenAPI
contract. The sibling `cotsel-dashboard-gateway.openapi.yml` file is a compact
external-reference index. Runtime and external release bundles are generated in
`gateway/.generated/openapi/` and are not committed.

## Change procedure

1. Edit the smallest applicable path or component fragment.
2. Add a new fragment to `manifest.json` when a new domain or chunk is needed.
3. Run `pnpm openapi:dashboard:index` from the repository root.
4. Run `pnpm openapi:dashboard:check` and the affected gateway contract tests.
5. Commit the source fragments and updated index together.

Do not edit the generated index or runtime bundle directly. The bundler rejects duplicate path,
schema, parameter, response, and security-scheme keys. Every source YAML file is
subject to the repository's 500-line limit.

The fragment split is an authoring boundary only. Internal component references
remain canonical `#/components/...` references in the generated OpenAPI contract.
