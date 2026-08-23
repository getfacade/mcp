/**
 * The end-to-end check: the whole journey (building, photo, design, refinement,
 * estimate, album) driven through a REAL MCP client over stdio, against a REAL
 * API, with a REAL agent key. No stub anywhere in the path.
 *
 * Deliberately NOT part of `npm test`. It creates a building and burns actual
 * render money on whatever API it is pointed at, so it is run by hand:
 *
 *   GETFACADE_API_KEY=... \
 *   GETFACADE_API_BASE_URL=http://localhost:8000/api/v1 \
 *   PHOTO=/path/to/a/photo-of-a-house.jpeg \
 *   RENDER=1 node test/live-journey.mjs
 *
 * With RENDER unset it stops before the paid leg (build, upload, validate),
 * which is enough to re-check the wire shapes after a change to the API.
 */

import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const key = process.env.GETFACADE_API_KEY;
const photo = process.env.PHOTO;

assert.ok(key, 'GETFACADE_API_KEY is required');
assert.ok(photo, 'PHOTO (path to an exterior photo) is required');

const client = new Client({ name: 'live-journey', version: '0.0.0' });

await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../src/index.js', import.meta.url).pathname],
    env: {
      PATH: process.env.PATH,
      GETFACADE_API_KEY: key,
      GETFACADE_API_BASE_URL: process.env.GETFACADE_API_BASE_URL ?? '',
    },
  }),
);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';

  console.log(`\n--- ${name}${result.isError ? ' (ERROR)' : ''}\n${text}`);
  assert.ok(!result.isError, `${name} failed`);

  return JSON.parse(text);
};

const before = await call('get_balance', {});
assert.equal(before.scope, 'api', 'the key must spend the agent wallet, not the app one');

const building = await call('create_building', {
  name: `MCP live ${Date.now()}`,
  goals: 'Modern farmhouse exterior',
});

const photoResult = await call('upload_photo', { building_id: building.building_id, file_path: photo });
assert.equal(photoResult.validation.is_valid, true, 'a rejected photo cannot be rendered');

if (process.env.RENDER === '1') {
  const design = await call('start_design', {
    building_id: building.building_id,
    view_id: photoResult.view_id,
    colors: ['#3B4A54'],
    prompt: 'dark grey siding, white trim',
  });

  let job;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    job = await call('get_job', { job_id: design.job_id });

    if (['completed', 'failed', 'error'].includes(String(job.status))) break;

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  assert.equal(job.status, 'completed');
  assert.ok(job.result_url, 'a completed render must hand the agent an image');

  const designs = await call('list_designs', { building_id: building.building_id });
  assert.equal(designs[0].has_main_render, true);

  const after = await call('get_balance', {});
  assert.ok(after.spent > before.spent, 'the render must land on this key, not on the human wallet');
}

await client.close();

console.log('\nlive journey: ok');
