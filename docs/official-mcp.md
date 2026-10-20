# Vendor MCP evidence

`Offer.official_mcp_servers` is optional. Include only servers published by the vendor itself. An absent field makes no claim about whether a server exists.

Each entry requires `kind` (`remote`, `npm`, `pypi`, or `github`), `target` (the HTTPS endpoint/repository URL or package name), `transport`, `authentication`, `doc_url`, `source_quote`, and `read_on` (YYYY-MM-DD). Use the vendor's wording for transport and authentication and a verbatim quotation from its documentation. No install command is generated. The OpenAPI `OfficialMcpServer` schema describes the served field.

Optional `retired_names` entries require `kind`, `target`, `notice`, `url`, and `read_on`. The notice is a verbatim registry or vendor statement. Prefer a documentation URL whose initial HTTP response contains the quotation; a client-rendered shell cannot establish it.

Build before using the scripts:

```sh
npm run build
node scripts/validate-data.ts
node scripts/check-official-mcp.js --index /tmp/proposed-index.json --preflight
```

`--preflight` exits unsuccessfully if any checked entry fails. Without `--write`, the checker previews its result and changes no file. `--state PATH` selects an isolated check store; `--date YYYY-MM-DD` selects the observation day for a replay or fixture. The default store is `data/official_mcp_checks.json`, overridable with `AGENTDEALS_OFFICIAL_MCP_CHECKS_PATH` for an isolated server or fixture.

The daily re-read invokes `node scripts/check-official-mcp.js --write` and includes the store in its existing tested data push. The store contains check history and review proposals. The checker never edits the curated listing field.

A check requires the documentation to return HTTP 200 and contain the quotation. Numeric HTML entities and markup whitespace are compared as rendered text. npm's latest version must exist without a deprecation notice. PyPI's latest release must have installable, non-yanked files. GitHub repository URLs must resolve. Remote endpoints receive an unauthenticated MCP initialize: HTTP 404/410 and connection/DNS/TLS failures fail; authentication and method responses such as 401/405 are accepted. Retired notices must remain at their registry or cited document.

One failed day keeps an entry published. Two consecutive failing calendar days withhold that entry and record a proposal. Repeating a check on one day does not count twice; a gap restarts the consecutive-day count. A passing later check restores publication. Check identities include the listing and all evidence fields, so changing the evidence starts a new history. Other entries on the same listing remain independent. The catalogue loader applies withholding before page, API and MCP readers receive records; the curated file stays intact.
