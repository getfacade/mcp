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
