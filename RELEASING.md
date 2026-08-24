# Releasing

A release is one tag. `.github/workflows/publish.yml` picks it up and publishes both halves:
the npm package and the entry in the [MCP registry](https://registry.modelcontextprotocol.io).

```bash
# 1. Bump the version in BOTH files: package.json and server.json.
#    The workflow refuses to publish if they disagree with each other or with the tag.
# 2. Commit, then tag and push.
git tag v0.1.0
git push origin v0.1.0
```

## The first release, 0.1.0

The workflow cannot do this one on its own, and the reason is npm's, not ours: a trusted
publisher can only be attached to a package that already exists, so the very first version has
to be pushed by a person. In order:

```bash
# 1. The scope has to exist and be yours. Create the `getfacade` org (or the scope) on
#    npmjs.com first — `npm publish` into a scope nobody owns fails with 404.
# 2. Make github.com/getfacade/mcp public. The registry entry and the npm page both link
#    to it, and a 404 next to a listing reads as an abandoned package.
npm login
npm publish                       # from a clean checkout of the tagged commit
# 3. On npmjs.com, attach the trusted publisher (below), so no human publishes again.
# 4. The registry half of 0.1.0, by hand, with the same key the workflow uses:
mcp-publisher login dns --domain getfacade.ai --private-key "$MCP_DNS_PRIVATE_KEY"
mcp-publisher publish
```

From 0.1.1 onward the tag does all of it.

## One-time setup

**npm trusted publishing.** The workflow carries no npm token: npm trusts this repository's
workflow through OIDC and signs the result, so the package page shows the commit it was built
from. It has to be turned on once, on npmjs.com, under the package's Settings, Trusted
publisher: this repository, workflow `publish.yml`, environment `publish`. A package must
exist before a trusted publisher can be attached to it, so version 0.1.0 is published by hand
and every version after it by the workflow.

**The registry key.** The name `ai.getfacade/mcp` is claimed through the domain, so publishing
is signed with the Ed25519 key behind the TXT record on the apex of `getfacade.ai`. The private
key is the `MCP_DNS_PRIVATE_KEY` secret of the `publish` environment, as the hex string that
`mcp-publisher` expects. On rotation, replace the TXT record and the secret together, and
remove the old record: a stale one is tried first and fails verification.
