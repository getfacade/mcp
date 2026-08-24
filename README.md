# @getfacade/mcp

MCP server for [GetFacade.ai](https://getfacade.ai): an agent creates a building, uploads a
photo of it, gets the exterior designed, priced and documented, without a human in front of a
screen.

Each design is worked out for the country the building stands in: materials that are applicable
there, manufacturer products that are actually sold there, and the technical build-up behind the
surface. The render shows that on the photo of the house.

The estimate and the album come from the same design:

- **The estimate** prices it line by line, in materials and labour, at what those materials cost
  in that country.
- **The album** documents it for the crew that builds it: the build-up of the facade, safety
  notes and the norms behind them.

The server is a thin wrapper over the public GetFacade API. It stores nothing, caches nothing
and decides nothing: every rule (pricing, admission, the colour grammar, every message) stays
on the server, and the wrapper only carries calls and answers.

## Requirements

- Node.js 20+
- An agent API key. Issue one for yourself at **app.getfacade.ai → Account → Settings → API**.
  The value is shown once and cannot be recovered; each key carries a hard spend cap.
- Agent access is paid. There are no trial credits in it: the key spends from the agent wallet,
  and without a balance the first paid call is refused with an explanation. An active Pro Plan
  fills that wallet up to 1,000 credits once per billing period; past that, credits are bought.

## Setup

Claude Desktop / any MCP client, `mcpServers` section:

```json
{
  "mcpServers": {
    "getfacade": {
      "command": "npx",
      "args": ["-y", "@getfacade/mcp"],
      "env": { "GETFACADE_API_KEY": "your-key" }
    }
  }
}
```

To run a checkout instead of the published package, point the client at it:
`"command": "node", "args": ["/path/to/mcp/src/index.js"]`.

| Variable | Required | Default |
|---|---|---|
| `GETFACADE_API_KEY` | yes | — |
| `GETFACADE_API_BASE_URL` | no | `https://api.getfacade.ai/api/v1` |
| `GETFACADE_LANG` | no | `en` |

Messages, including refusals, come from the service in the language of
`GETFACADE_LANG`. Set it to the language the answer should be read in.

## Tools

| Tool | What it does |
|---|---|
| `create_building` | Creates a building. The name is unique per account. |
| `upload_photo` | Registers a view, uploads the bytes, confirms, waits for validation. |
| `start_design` | Creates a design and queues its render. Returns a job id. |
| `refine_design` | Changes a finished design in words. Every step after the first. |
| `get_job` | Polls one render, estimate or album. |
| `list_jobs` | Recent jobs across the account, unfinished first. |
| `list_designs` | Designs of a building with their renders and finished picture. |
| `order_estimate` | Orders a cost estimate for chosen renders. |
| `order_album` | Orders the PDF album for chosen renders. |
| `upscale_render` | Enlarges a finished render. Costs tokens, asynchronous. |
| `get_estimate` | The estimate itself: totals, assumptions and every line. |
| `add_estimate_line` | Adds one line to an estimate. |
| `update_estimate_line` | Edits one line of an estimate. |
| `delete_estimate_line` | Removes one line from an estimate. |
| `delete_render` | Deletes one render. The main render's design returns to draft. |
| `delete_design` | Deletes one design with the renders under it. |
| `delete_building` | Deletes a building with everything under it. |
| `list_token_packages` | The packages this account can buy. |
| `buy_tokens` | Refills this key's wallet. See below. |
| `get_balance` | Agent wallet, key cap, and whether the next paid call will be accepted. |
| `report_problem` | Reports a defect in this API. Free, and works on an empty wallet. |

Rendering is asynchronous: `start_design`, `refine_design`, `order_estimate` and `order_album` return a job id
immediately, and `get_job` reports when it is done. A finished estimate reads `ready` where a
render and an album read `completed`. The only call that waits is `upload_photo`, which polls
until the photo is accepted or rejected.

## A paid call is never ordered twice

`start_design`, `refine_design`, `order_estimate`, `order_album` and `upscale_render` cost
money, and the charge follows the job that gets created. If one of them times out, the honest
question is whether the job exists, and the agent cannot answer it from where it stands.

So this server answers it instead. Every paid call goes out under a name of its own
(`Idempotency-Key`), and this server, not the agent, retries it under that same name when the
connection fails or when the API says the first attempt is still running. The API recognises
the repeat and hands back the original job, so a timeout costs one design, not two.

Nothing about this reaches the tool arguments: ordering the same design twice on purpose stays
possible, because two calls are two names. What is gone is the accidental second order.

The API requires that name on every paid call made with an API key, so calling it without this
wrapper means sending the header yourself. The reference is at getfacade.ai/agents.

## What the key can reach

A key is a bearer secret that lives in your agent's config, so its reach is the published agent
surface and nothing else: buildings, photos, designs, renders, estimates, albums, the jobs list
and the API wallet. Anything outside that answers `403 AGENT_SURFACE_FORBIDDEN`, including the
account's own sign-in settings, its subscription and its payment history. Changing those, and
issuing or revoking keys, is done by a person signed in to the app.

The reference is at [getfacade.ai/agents](https://getfacade.ai/agents).

## Results are permanent public links

A finished render (`result_url`, `main_render_url`) and a finished album (`result_url`) are
served from stable URLs: no signature, no expiry. An assistant can hand one straight to a
person as the answer to "show me the result", with nothing to refresh and no second call.

The honest half of that: because the link is unsigned it asks nobody for permission, so it
keeps working for whoever it is forwarded to, and it cannot be recalled afterwards. Share it as
deliberately as any other link that is public forever. `GET /renders/{render}/download` is a
different thing — a short-lived signed URL with a filename, for saving the file rather than for
sharing it.

Deletions are soft on the server: a person can undo them in the app, this server cannot.

`buy_tokens` works only if the key was issued with **purchasing enabled** (a switch on the
issue screen), and only up to what the key may still spend — a purchase never lifts the key's
own spend cap. It answers `charged` when the payment provider took it from a saved payment
method, or `requires_human` with a `checkout_url` for a person to open. Either way the tokens
are credited when the payment is confirmed, so poll `get_balance`.

Issuing keys and buying a subscription are deliberately absent: a key that can issue itself a
key has no ceiling, and a subscription is bought by a person, in the app.

## License

MIT (see `LICENSE`) — this wrapper carries calls and answers and nothing else, so there is
nothing in it to keep closed. The GetFacade service it talks to is a separate matter: using it
is governed by the terms at [getfacade.ai/terms](https://getfacade.ai/terms), and a key is
issued to an account, not to this package.

## Development

```bash
npm install
npm test    # smoke test against a stub of the API
```

`test/live-journey.mjs` drives the whole journey through a real MCP client against a real API
with a real key. It is not part of `npm test`, because it spends actual credits; the header of
the file says how to run it.

Releases: see [RELEASING.md](RELEASING.md).
