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

/** Poll one job to its end. An album takes longer than a render, so the budget
 * is generous; a job still running when it expires is a failure worth seeing. */
const settle = async (jobId, kind = 'render', designId) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await call('get_job', {
      job_id: jobId,
      kind,
      ...(designId ? { design_id: designId } : {}),
    });

    // The finished word differs by kind: a render and an album read
    // `completed`, an estimate reads `ready`. Treating them as one status here
    // would hide exactly the mismatch this journey exists to catch.
    if (['completed', 'ready', 'failed', 'error'].includes(String(job.status))) return job;

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error(`job ${jobId} never finished`);
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

  const job = await settle(design.job_id);

  assert.equal(job.status, 'completed');
  assert.ok(job.result_url, 'a completed render must hand the agent an image');

  const designs = await call('list_designs', { building_id: building.building_id });
  assert.equal(designs[0].has_main_render, true);

  // Everything below is the part an agent reaches only after a picture exists,
  // and it is the part that used to go unchecked: the header promised it, the
  // script stopped at the render. A refusal here (a stale estimate, an album
  // ordered against an unfinished render) is invisible until somebody pays for
  // it, so the journey now buys all three legs on the same design.
  const refined = await call('refine_design', {
    render_id: design.job_id,
    instruction: 'make the roof darker',
  });

  const refinedJob = await settle(refined.job_id);
  assert.equal(refinedJob.status, 'completed');
  assert.ok(refinedJob.result_url, 'a refinement must hand back its own picture');

  const estimateOrder = await call('order_estimate', {
    design_id: design.design_id,
    building_id: building.building_id,
    render_ids: [design.job_id],
  });

  const estimateJob = await settle(estimateOrder.job_id, 'estimate');
  assert.equal(estimateJob.status, 'ready');

  const estimate = await call('get_estimate', { estimate_id: estimateOrder.job_id });
  assert.ok(estimate.lines?.length, 'an estimate with no lines prices nothing');

  const albumOrder = await call('order_album', {
    design_id: design.design_id,
    render_ids: [design.job_id],
    include_estimate: true,
    estimate_id: estimateOrder.job_id,
  });

  const albumJob = await settle(albumOrder.job_id, 'album', design.design_id);
  assert.equal(albumJob.status, 'completed');
  assert.ok(albumJob.result_url, 'a finished album must be a link somebody can open');

  const after = await call('get_balance', {});
  assert.ok(after.spent > before.spent, 'the render must land on this key, not on the human wallet');
  console.log(`\nspent on this journey: ${(after.spent - before.spent).toFixed(2)} tokens`);
}

await client.close();

console.log('\nlive journey: ok');
