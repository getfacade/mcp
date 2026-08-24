/**
 * Smoke test: the server starts, advertises exactly the tools it documents,
 * and speaks the real wire shapes.
 *
 * It runs against a stub of the API rather than the live one, because what
 * is worth protecting here is the mapping — path, body shape, and the rule that
 * an API refusal reaches the agent in the API's own words. Anything beyond that
 * belongs to the API's own suite.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const calls = [];
let upscaleAttempts = 0;

const stub = createServer(async (req, res) => {
  const body = await new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : null));
  });

  calls.push({
    method: req.method,
    url: req.url,
    body,
    auth: req.headers.authorization,
    idempotencyKey: req.headers['idempotency-key'],
  });

  const reply = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (req.url === '/api/v1/projects' && req.method === 'POST') {
    return reply(201, { data: { type: 'project', id: 'bld-1', attributes: { name: body.data.attributes.name } } });
  }

  if (req.url === '/api/v1/tokens/balance') {
    return reply(200, {
      data: {
        type: 'token-balance',
        id: 'u-1',
        attributes: {
          current_balance: 7,
          agent: {
            scope: 'api',
            balance: 500,
            key: { id: '9', label: 'laptop bot', spend_cap: 120, spent: 20, remaining: 100, is_exhausted: false },
            is_admissible: true,
          },
        },
      },
    });
  }

  if (req.url.startsWith('/api/v1/projects/bld-1/concepts') && req.method === 'POST') {
    return reply(402, {
      errors: [{ status: '402', code: 'AGENT_KEY_CAP_REACHED', title: 'Payment required', detail: 'This agent key has reached its spend cap.' }],
    });
  }

  // Shaped like the real listing: renders arrive as identifiers only.
  if (req.url.startsWith('/api/v1/projects/bld-1/concepts') && req.method === 'GET') {
    return reply(200, {
      data: [
        {
          type: 'concept',
          id: 'design-1',
          attributes: { note: null, has_main_render: true, main_render_id: 'render-1', main_render_url: 'https://cdn.test/r.png' },
          relationships: { renders: { data: [{ type: 'renders', id: 'render-1' }] } },
        },
      ],
    });
  }

  // The parent of a refine: the render says which design and which view it
  // belongs to, and that is the only place `refine_design` may learn it from.
  if (req.url === '/api/v1/renders/render-1' && req.method === 'GET') {
    return reply(200, {
      data: {
        type: 'renders',
        id: 'render-1',
        attributes: { status: 'completed' },
        relationships: {
          concept_angle: { data: { type: 'concept-angles', id: 'ca-1' }, meta: { concept_id: 'design-1' } },
        },
      },
    });
  }

  // A refine of a main view is forked into a NEW design by the server; the
  // wrapper has to report the design the answer actually landed in.
  if (req.url === '/api/v1/concepts/design-1/angles/ca-1/renders' && req.method === 'POST') {
    return reply(201, {
      data: {
        type: 'renders',
        id: 'render-2',
        attributes: { status: 'pending', settings: { seed: 777 } },
        relationships: {
          concept_angle: { data: { type: 'concept-angles', id: 'ca-2' }, meta: { concept_id: 'design-2' } },
        },
      },
    });
  }

  // A 204 with no body: the delete tools must report success from the status
  // alone rather than reading a document that is not there.
  if (req.url === '/api/v1/renders/render-1' && req.method === 'DELETE') {
    res.writeHead(204);
    return res.end();
  }

  // Paid calls are named with an Idempotency-Key and retried by the wrapper,
  // not by the agent. The first attempt here answers "the original is still
  // running", exactly as the API does when a retry overtakes it; the second
  // must arrive under the SAME name and is answered for real.
  if (req.url === '/api/v1/renders/render-1/upscale' && req.method === 'POST') {
    upscaleAttempts += 1;

    if (upscaleAttempts === 1) {
      return reply(409, {
        errors: [{
          status: '409',
          code: 'IDEMPOTENCY_IN_PROGRESS',
          title: 'Request could not be replayed',
          detail: 'The original request with this Idempotency-Key has not finished yet.',
        }],
      });
    }

    return reply(201, { data: { type: 'renders', id: 'upscale-1', attributes: { status: 'pending' } } });
  }

  if (req.url === '/api/v1/tokens/purchase' && req.method === 'POST') {
    return reply(403, {
      errors: [{
        status: '403',
        code: 'AGENT_PURCHASE_NOT_ALLOWED',
        title: 'Key cannot be issued',
        detail: 'This key was issued without permission to buy tokens.',
        meta: {},
      }],
    });
  }

  // Shaped like the real /history: the kind lives in the row TYPE, and the
  // building and the design live in relationships, not in attributes.
  if (req.url.startsWith('/api/v1/history') && req.method === 'GET') {
    return reply(200, {
      data: [
        {
          type: 'job-album',
          id: 'album-1',
          attributes: { status: 'processing', created_at: '2026-08-24T09:00:00+00:00' },
          relationships: {
            concept: { data: { type: 'concepts', id: 'design-1' } },
            project: { data: { type: 'projects', id: 'bld-1' } },
          },
        },
      ],
    });
  }

  if (req.url === '/api/v1/feedback' && req.method === 'POST') {
    return reply(201, {
      data: {
        type: 'feedback',
        id: 'tkt-1',
        attributes: { reference: 'TKT-260823-AB12', message: 'Report received. Reference: TKT-260823-AB12.' },
      },
    });
  }

  return reply(404, { message: 'not stubbed' });
});

await new Promise((resolve) => stub.listen(0, resolve));
const baseUrl = `http://127.0.0.1:${stub.address().port}/api/v1`;

const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../src/index.js', import.meta.url).pathname],
    env: { ...process.env, GETFACADE_API_KEY: 'test-key', GETFACADE_API_BASE_URL: baseUrl },
  }),
);

const { tools } = await client.listTools();
const names = tools.map((tool) => tool.name).sort();

assert.deepEqual(names, [
  'add_estimate_line',
  'buy_tokens',
  'create_building',
  'delete_building',
  'delete_design',
  'delete_estimate_line',
  'delete_render',
  'get_balance',
  'get_estimate',
  'get_job',
  'list_designs',
  'list_jobs',
  'list_token_packages',
  'order_album',
  'order_estimate',
  'refine_design',
  'report_problem',
  'start_design',
  'update_estimate_line',
  'upload_photo',
  'upscale_render',
]);

// Every tool declares its annotations. A client decides from them whether a
// call needs the person's confirmation, and both directories reject a server
// that ships a tool without them, so a new tool missing one must fail here
// rather than at review. The four deletes and the estimate-line edit are the
// only calls that may take something away, and nothing that reads may write.
for (const tool of tools) {
  const hints = tool.annotations;

  assert.ok(hints, `tool ${tool.name} ships without annotations`);
  assert.equal(hints.openWorldHint, true, `tool ${tool.name} talks to the service`);

  const isRead = tool.name.startsWith('get_') || tool.name.startsWith('list_');
  assert.equal(hints.readOnlyHint, isRead, `tool ${tool.name} is annotated as the wrong kind`);

  if (!isRead) {
    const takesAway = tool.name.startsWith('delete_') || tool.name === 'update_estimate_line';

    assert.equal(hints.destructiveHint, takesAway, `tool ${tool.name} misdeclares what it destroys`);
  }
}

// Spending is never idempotent: a repeat of a purchase is a second charge, and
// a client that treated it as safe to retry would double it.
assert.equal(tools.find((tool) => tool.name === 'buy_tokens').annotations.idempotentHint, false);

const created = JSON.parse((await client.callTool({ name: 'create_building', arguments: { name: 'Maple St 14' } })).content[0].text);
assert.equal(created.building_id, 'bld-1');
assert.equal(calls[0].auth, 'Bearer test-key');
assert.equal(calls[0].body.data.type, 'project');

// A delete answers 204 with no body; the wrapper must not try to read one.
const deleted = JSON.parse((await client.callTool({ name: 'delete_render', arguments: { render_id: 'render-1' } })).content[0].text);
assert.deepEqual(deleted, { render_id: 'render-1', deleted: true });
assert.equal(calls.at(-1).method, 'DELETE');

// A refused purchase reaches the agent in the API's own words, with the code it
// can branch on — the wrapper adds no wording of its own.
const refusedPurchase = await client.callTool({ name: 'buy_tokens', arguments: { package: '150' } });
assert.match(refusedPurchase.content[0].text, /without permission to buy tokens/);

// Buying names its attempt like every other call that moves money: a purchase
// that times out after the provider took it must come back as the same one.
const purchaseCall = calls.find((call) => call.url === '/api/v1/tokens/purchase');
assert.ok(purchaseCall.idempotencyKey, 'a purchase must name its attempt');

// The job list answers in the vocabulary get_job asks for: `kind` without the
// `job-` prefix the wire uses, plus the design an album can only be polled by.
const jobs = JSON.parse((await client.callTool({ name: 'list_jobs', arguments: {} })).content[0].text);
assert.deepEqual(jobs, [
  {
    job_id: 'album-1',
    kind: 'album',
    status: 'processing',
    building_id: 'bld-1',
    design_id: 'design-1',
    created_at: '2026-08-24T09:00:00+00:00',
  },
]);

const balance = JSON.parse((await client.callTool({ name: 'get_balance', arguments: {} })).content[0].text);
assert.deepEqual(balance, { scope: 'api', balance: 500, limit: 120, spent: 20, remaining: 100, is_admissible: true });

// The listing says what it knows (the finished main render) and does not
// invent a per-render status the endpoint never sends.
const designs = JSON.parse((await client.callTool({ name: 'list_designs', arguments: { building_id: 'bld-1' } })).content[0].text);
assert.deepEqual(designs, [
  {
    design_id: 'design-1',
    note: null,
    has_main_render: true,
    main_render_id: 'render-1',
    main_render_url: 'https://cdn.test/r.png',
    renders: [{ id: 'render-1' }],
  },
]);

// The refine loop: the parent render names its own design and view, the call
// goes out as mode=refine with the wish as prompt_concept, and the answer
// reports the NEW design the server forked rather than the parent's.
const refined = JSON.parse(
  (await client.callTool({ name: 'refine_design', arguments: { render_id: 'render-1', instruction: 'Put a canopy over the front door' } })).content[0].text,
);
assert.deepEqual(refined, {
  design_id: 'design-2',
  job_id: 'render-2',
  status: 'pending',
  parent_render_id: 'render-1',
  seed: 777,
});

const refineCall = calls.at(-1);
assert.equal(refineCall.url, '/api/v1/concepts/design-1/angles/ca-1/renders');
assert.equal(refineCall.body.data.attributes.mode, 'refine');
assert.equal(refineCall.body.data.attributes.parent_render_id, 'render-1');
assert.equal(refineCall.body.data.attributes.prompts.prompt_concept, 'Put a canopy over the front door');
assert.equal(refineCall.body.data.attributes.version, 1);

// Neither id given: the wrapper says so itself instead of posting a request the
// API would have to refuse.
const noTarget = await client.callTool({ name: 'refine_design', arguments: { instruction: 'darker roof' } });
assert.equal(noTarget.isError, true);
assert.match(noTarget.content[0].text, /render_id/);

// A refusal reaches the agent verbatim, with the code it needs to branch on.
const refused = await client.callTool({ name: 'start_design', arguments: { building_id: 'bld-1', view_id: 'view-1' } });
assert.equal(refused.isError, true);
const error = JSON.parse(refused.content[0].text);
assert.equal(error.code, 'AGENT_KEY_CAP_REACHED');
assert.equal(error.error, 'This agent key has reached its spend cap.');
assert.equal(error.http_status, 402);

// Reporting a defect in the API is a plain authenticated POST with the context
// attached; the reference comes back for the agent to quote to a person.
const reported = JSON.parse(
  (await client.callTool({
    name: 'report_problem',
    arguments: {
      message: 'start_design answered 201 but the job never left pending.',
      context: { tool: 'start_design', job_id: 'render-9' },
    },
  })).content[0].text,
);
assert.equal(reported.reference, 'TKT-260823-AB12');

const reportCall = calls.at(-1);
assert.equal(reportCall.url, '/api/v1/feedback');
assert.equal(reportCall.body.data.type, 'feedback');
assert.equal(reportCall.body.data.attributes.category, 'bug_report');
assert.equal(reportCall.body.data.attributes.context.tool, 'start_design');

// The paid call was retried under one name, so the API could recognise the
// second attempt as the same order instead of charging for a second upscale.
const upscaled = JSON.parse((await client.callTool({ name: 'upscale_render', arguments: { render_id: 'render-1' } })).content[0].text);
assert.deepEqual(upscaled, { job_id: 'upscale-1', status: 'pending' });

const upscaleCalls = calls.filter((call) => call.url === '/api/v1/renders/render-1/upscale');
assert.equal(upscaleCalls.length, 2);
assert.ok(upscaleCalls[0].idempotencyKey, 'a paid call must name its attempt');
assert.equal(upscaleCalls[0].idempotencyKey, upscaleCalls[1].idempotencyKey);

// An unpaid call carries no name: the API requires one only where money moves,
// and a key that meant nothing would teach the agent to send one where it does
// not help.
const buildingCall = calls.find((call) => call.url === '/api/v1/projects' && call.method === 'POST');
assert.equal(buildingCall.idempotencyKey, undefined);

// Two separate orders are two names, even with identical arguments: an agent
// exploring variants means both of them.
const firstRefine = calls.filter((call) => call.url === '/api/v1/concepts/design-1/angles/ca-1/renders');
assert.ok(firstRefine[0].idempotencyKey);

await client.close();
stub.close();

console.log('smoke: ok');
