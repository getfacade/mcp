#!/usr/bin/env node
/**
 * GetFacade MCP server.
 *
 * A thin wrapper over the public API and nothing more: it holds no state, keeps
 * no cache and takes no decision the server could take. The key arrives in the
 * environment, so the agent runtime owns the secret and this process never
 * writes it anywhere. The server itself is assembled in server.js.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { GetFacadeApi, createGetFacadeServer } from './server.js';

const api = new GetFacadeApi({
  apiKey: process.env.GETFACADE_API_KEY,
  baseUrl: process.env.GETFACADE_API_BASE_URL,
  language: process.env.GETFACADE_LANG,
});

await createGetFacadeServer({ api, mode: 'local' }).connect(new StdioServerTransport());
