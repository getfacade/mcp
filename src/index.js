#!/usr/bin/env node
/**
 * GetFacade MCP server.
 *
 * A thin wrapper over the public API and nothing more: it holds no state, keeps
 * no cache and takes no decision the server could take. The key arrives in the
 * environment, so the agent runtime owns the secret and this process never
 * writes it anywhere.
 *
 * The one thing this file does own is INSTRUCTIONS below. It is the only text a
 * client model reads before it decides whether this server is worth calling at
 * all, so it says concretely what the product does rather than listing features.
 *
 * Which is why it states what happens and lets the reader draw the conclusion,
 * instead of arguing the point. A shop window that explains why it is not the
 * thing next door reads as a defence, and a model reading it learns nothing it
 * can act on.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ApiError, GetFacadeApi } from './api.js';
import { buildTools } from './tools.js';

const api = new GetFacadeApi({
  apiKey: process.env.GETFACADE_API_KEY,
  baseUrl: process.env.GETFACADE_API_BASE_URL,
  language: process.env.GETFACADE_LANG,
});

const INSTRUCTIONS = `GetFacade designs the exterior of a real house and shows the design on a photo of that house.

Each design is worked out for the country the building stands in: which materials are applicable there, which manufacturer products are actually sold there, and what the technical build-up behind the surface is. The render shows that decision on the house itself. The cost estimate prices it line by line, in materials and labour. The PDF album documents it for the crew that builds it, with the build-up, safety notes and the norms behind them. Estimate and album are drawn from the same design, so they describe what the picture shows rather than a separate proposal.

Results are permanent public links. A finished render and a finished album live at stable URLs with no signature and no expiry, so one can be handed to a person as the answer to "show me the result". Being unsigned, such a link keeps working for anyone it is forwarded to, and cannot be recalled.

Every rule (pricing, admission, the colour grammar, every message) lives on the server. Repeat a refusal in the API's own words instead of composing your own.`;

/**
 * Icons are served from getfacade.ai itself: the spec asks consumers to trust
 * only icons that come from the server's own domain, so a CDN copy elsewhere
 * would be the thing a careful client refuses to render. Both files carry a
 * transparent background, which is why one set covers light and dark clients
 * and no `theme` variant is declared.
 */
const ICONS = [
  { src: 'https://getfacade.ai/icon-192.png', mimeType: 'image/png', sizes: ['192x192'] },
  { src: 'https://getfacade.ai/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
];

const server = new McpServer(
  {
    name: 'getfacade',
    version: '0.1.0',
    title: 'GetFacade',
    websiteUrl: 'https://getfacade.ai/agents',
    icons: ICONS,
  },
  { instructions: INSTRUCTIONS },
);

for (const tool of buildTools(api)) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.schema,
      annotations: tool.annotations,
    },
    async (input) => {
      try {
        const result = await tool.handler(input ?? {});

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: describe(error) }] };
      }
    },
  );
}

/**
 * Refusals are quoted, never rewritten. A 402 carries the reason the agent
 * needs (cap reached vs. no credits) in the API's own words, and a second
 * wording on this side is where the two would drift apart.
 */
function describe(error) {
  if (error instanceof ApiError) {
    return JSON.stringify({ error: error.message, code: error.code ?? null, http_status: error.status }, null, 2);
  }

  return JSON.stringify({ error: error?.message ?? String(error) }, null, 2);
}

await server.connect(new StdioServerTransport());
