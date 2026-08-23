/**
 * The tools this server offers, and nothing else.
 *
 * The descriptions are the product's shop window: a client model reads them,
 * not the landing page. So they say what the work is. A design is a decision
 * about materials, manufacturer products and the build-up of the facade, and
 * the render is how that decision is shown on the house; the estimate and the
 * album are the same decision in more detail. Nothing here describes this
 * server as an image generator, because that is not what is being sold.
 *
 * Every handler here is one or more existing HTTP calls in sequence. There is
 * no decision, no cache and no local dictionary: the colour grammar, the token
 * price, the admission rule and every message all stay on the server, which is
 * the only thing that keeps this wrapper from becoming a second API.
 */

import { z } from 'zod';
import { readImage } from './image.js';

/**
 * How long `upload_photo` is willing to wait for validation, and how often it
 * asks.
 *
 * The budget is deliberately under a minute: MCP clients cut a tool call off at
 * around 60s, and a wait that outlives the client turns a finished upload into
 * a timeout the agent cannot tell from a failure. Waiting less and saying so is
 * the honest answer, and re-calling `upload_photo` with the same file resumes
 * the wait on the same view rather than uploading anything twice.
 */
const VALIDATION_POLL_INTERVAL_MS = 2000;
const VALIDATION_POLL_ATTEMPTS = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function buildTools(api) {
  return [
    {
      name: 'create_building',
      title: 'Create a building',
      description:
        'Create a building (a house to design). The name must be unique within the account, max 50 characters — reusing a name is refused, so pick a distinct one instead of retrying the same. `goals` is the free-form brief (max 10000 chars).',
      schema: {
        name: z.string().max(50).describe('Unique building name within this account'),
        goals: z.string().max(10000).optional().describe('Free-form brief for the design'),
        construction_region: z.string().max(255).optional().describe('Region, used for pricing and regulations'),
      },
      async handler({ name, goals, construction_region }) {
        const created = await api.post('/projects', {
          data: {
            type: 'project',
            attributes: { name, goals, construction_region },
          },
        });

        return { building_id: created.data.id, name: created.data.attributes?.name ?? name };
      },
    },

    {
      name: 'upload_photo',
      title: 'Upload a photo of the building',
      description:
        'Upload an exterior photo of the building and wait for it to be validated. Three legs: register the view, PUT the bytes to storage, confirm. Validation is asynchronous; the result says whether the photo was accepted, and a rejected photo cannot be rendered. The wait is bounded: a `pending` answer means validation is still running, and calling this again with the same file resumes it on the same view rather than uploading a second copy.',
      schema: {
        building_id: z.string().describe('Building id from create_building'),
        file_path: z.string().describe('Absolute path to a JPEG, PNG or WebP file on this machine'),
        wait_for_validation: z.boolean().optional().default(true),
      },
      async handler({ building_id, file_path, wait_for_validation = true }) {
        const image = await readImage(file_path);

        const registered = await api.post(`/projects/${building_id}/angles`, {
          data: {
            type: 'angle',
            attributes: {
              md5: image.md5,
              width: image.width,
              height: image.height,
              file_name: image.fileName,
              content_type: image.contentType,
              // aspect_ratio deliberately omitted — the server derives it.
            },
          },
        });

        const angleId = registered.data.id;
        const policy = registered.data.attributes?.upload_policy;

        if (!policy) {
          throw new Error('The API returned no upload policy for this view; the photo cannot be uploaded.');
        }

        await api.putFile(policy, image.bytes, image.contentType);
        await api.post(`/angles/${angleId}/confirm`, {});

        if (!wait_for_validation) {
          return { view_id: angleId, validation: { status: 'pending' } };
        }

        return { view_id: angleId, validation: await waitForValidation(api, angleId) };
      },
    },

    {
      name: 'start_design',
      title: 'Start a design render',
      description:
        'Design the exterior of this house on a chosen view, and show the result as a picture. The design is worked out against the building\'s country: which materials are applicable there, which manufacturer products are really sold there, and what the build-up behind the surface is — the render is how that decision is shown, not a picture made for its own sake. Creates a new design (concept) and queues the work; returns a job id to poll with get_job. `prompt` is the free-form wish for this design ("a modern facade with a wide porch"). Colors accept the same strings the apps use: "palette:1", "paint:412", "siding:88@double-4-dutchlap" or "#RRGGBB" — order carries the 60/30/10 role, the first entry is the dominant wall color; `brand_selections` names real manufacturer products: "siding:brand:12", "siding:line:40@double-4-dutchlap", "paint:product:412". Omit `seed` unless reproducing an earlier render. To change a design that already rendered, use refine_design instead of starting another one.',
      schema: {
        building_id: z.string(),
        view_id: z.string().describe('View id from upload_photo'),
        style_ids: z.array(z.number().int()).max(10).optional(),
        colors: z.array(z.string()).max(10).optional(),
        brand_selections: z.array(z.string()).max(10).optional().describe('Manufacturer products, e.g. "paint:product:412"'),
        prompt: z.string().max(400).optional().describe('Free-form instruction for this design'),
        seed: z.number().int().min(1).max(2147483647).optional(),
      },
      async handler({ building_id, view_id, style_ids, colors, brand_selections, prompt, seed }) {
        const concept = await api.post(`/projects/${building_id}/concepts`, {
          data: {
            type: 'concept',
            relationships: { main_angle: { data: { type: 'angle', id: view_id } } },
          },
        });

        const conceptId = concept.data.id;
        const conceptAngleId = await resolveMainConceptAngleId(api, concept);

        if (!conceptAngleId) {
          throw new Error('The created design has no main view to render; check that the view belongs to this building.');
        }

        const render = await api.postPaid(`/concepts/${conceptId}/angles/${conceptAngleId}/renders`, {
          data: {
            type: 'render',
            attributes: {
              version: 1,
              seed,
              style_ids,
              colors,
              brand_selections,
              prompts: prompt ? { prompt_concept: prompt } : undefined,
            },
          },
        });

        return {
          design_id: conceptId,
          job_id: render.data.id,
          status: render.data.attributes?.status,
          seed: render.data.attributes?.settings?.seed,
        };
      },
    },

    {
      name: 'refine_design',
      title: 'Refine a design',
      description:
        'Revise a finished design in words: "put a canopy over the front door", "make the roof darker". The revision is applied to the finished design, so what is not mentioned stays as it is — this is the tool for every step after the first, not start_design. Give it either the `render_id` of the picture to change (the job id start_design returned) or the `design_id` (with `building_id`) of the design whose finished main render should be changed. The parent render must be finished; refining an unfinished one is refused. Queues a render and returns a new job id, plus the `design_id` the result lands in (the server keeps every step as its own design, so the previous picture is never overwritten). Styles, colors and brands are optional here: pass them only to change them.',
      schema: {
        render_id: z.string().optional().describe('Render to iterate on — the job id from start_design or an earlier refine_design'),
        design_id: z.string().optional().describe('Alternative to render_id: the design whose finished main render to iterate on. Needs building_id too'),
        building_id: z.string().optional().describe('Required with design_id'),
        instruction: z.string().max(400).describe('What to change, in plain words'),
        style_ids: z.array(z.number().int()).max(10).optional(),
        colors: z.array(z.string()).max(10).optional(),
        brand_selections: z.array(z.string()).max(10).optional(),
        seed: z.number().int().min(1).max(2147483647).optional(),
      },
      async handler({ render_id, design_id, building_id, instruction, style_ids, colors, brand_selections, seed }) {
        if (!render_id && !design_id) {
          throw new Error('refine_design needs either `render_id` (the picture to change) or `design_id` (the design whose finished render to change).');
        }

        const parentRenderId = render_id ?? (await resolveMainRenderId(api, building_id, design_id));
        const parent = await api.get(`/renders/${parentRenderId}`);
        const conceptAngle = parent.data?.relationships?.concept_angle;
        const conceptAngleId = conceptAngle?.data?.id;
        const conceptId = conceptAngle?.meta?.concept_id;

        if (!conceptAngleId || !conceptId) {
          throw new Error(`Render ${parentRenderId} does not say which design it belongs to; it cannot be refined.`);
        }

        // The view (main or secondary) is taken from the parent render rather
        // than asked for: the API requires a refine to stay in the same stack
        // as its parent, so any answer but this one would be a 422.
        const render = await api.postPaid(`/concepts/${conceptId}/angles/${conceptAngleId}/renders`, {
          data: {
            type: 'render',
            attributes: {
              version: 1,
              mode: 'refine',
              parent_render_id: parentRenderId,
              seed,
              style_ids,
              colors,
              brand_selections,
              prompts: { prompt_concept: instruction },
            },
          },
        });

        return {
          // A refine of a main view lands in a NEW design (the server forks the
          // concept so the earlier picture stays), so the design to read back is
          // the one the fresh render reports, not the parent's.
          design_id: render.data?.relationships?.concept_angle?.meta?.concept_id ?? conceptId,
          job_id: render.data.id,
          status: render.data.attributes?.status,
          parent_render_id: parentRenderId,
          seed: render.data.attributes?.settings?.seed,
        };
      },
    },

    {
      name: 'get_job',
      title: 'Check one job',
      description:
        'Poll one queued job. `kind` says what it is: a render, an estimate, or an album (albums are listed per design, so an album lookup needs `design_id`). The finished status differs by kind: a render and an album read `completed`, an estimate reads `ready`. Stop polling on any of those and on `failed`, where `error` says what went wrong and `error_code` names it; repeat that reason as it stands instead of composing one. A render and an album report `expected_seconds`, how long that job usually takes end to end, so the wait between polls can be paced by it; an estimate does not, and reads null. The `result_url` of a finished job is a permanent public link: no signature, no expiry, so it can be handed to a person as it stands. It also keeps working for anyone it is forwarded to and cannot be recalled, so pass it on as deliberately as any other shared link.',
      schema: {
        job_id: z.string(),
        kind: z.enum(['render', 'album', 'estimate']).optional().default('render'),
        design_id: z.string().optional().describe('Required when kind is "album"'),
      },
      async handler({ job_id, kind = 'render', design_id }) {
        if (kind === 'render') {
          const render = await api.get(`/renders/${job_id}`);

          const attributes = render.data.attributes ?? {};

          return {
            status: attributes.status,
            // How long this render usually takes end to end, so the wait between
            // polls is chosen from the server's own estimate rather than guessed.
            expected_seconds: attributes.typical_duration ?? attributes.duration_predicted ?? null,
            started_at: attributes.started_at ?? null,
            result_url: attributes.file_url ?? null,
            error: attributes.error_message ?? null,
            error_code: attributes.error_code ?? null,
          };
        }

        if (kind === 'estimate') {
          const estimate = await api.get(`/estimates/${job_id}`);

          // Every kind answers with the same keys, so an agent polls all three
          // the same way. The server publishes no duration for an estimate, and
          // a guessed one here would be a second, drifting truth.
          return {
            status: estimate.data.attributes?.status,
            expected_seconds: null,
            started_at: null,
            error: estimate.data.attributes?.failure_reason ?? null,
          };
        }

        if (!design_id) throw new Error('Checking an album needs `design_id` — albums are listed per design.');

        const albums = await api.get(`/concepts/${design_id}/album`);
        const album = (albums.data ?? []).find((row) => row.id === job_id);

        if (!album) throw new Error(`No album ${job_id} on design ${design_id}.`);

        return {
          status: album.attributes?.status,
          // An album is the longest job of the three (minutes, not seconds) and
          // the server sizes each one at creation from what it was asked to
          // include. Reading that back is what lets the wait be paced instead
          // of polled blind.
          expected_seconds: album.attributes?.duration_predicted ?? null,
          started_at: album.attributes?.started_at ?? null,
          result_url: album.attributes?.public_url ?? null,
          error: album.attributes?.error_message ?? null,
        };
      },
    },

    {
      name: 'list_jobs',
      title: 'List recent jobs',
      description:
        'Recent jobs across the account — renders, estimates and albums in one list, unfinished ones first. Use it to catch up after a restart: each row carries the `kind` and `design_id` that get_job asks for, and the `building_id` the job belongs to. Use get_job to poll a single known job.',
      schema: {
        kind: z.enum(['render', 'album', 'estimate']).optional(),
        limit: z.number().int().min(1).max(100).optional().default(20),
      },
      async handler({ kind, limit = 20 }) {
        const history = await api.get('/history', {
          'filter[type]': 'jobs',
          ...(kind ? { 'filter[subtype]': kind } : {}),
          'page[size]': limit,
        });

        // The listing types its rows `job-render` / `job-album` / `job-estimate`
        // and puts the building and the design in relationships, not in
        // attributes. Both are translated here rather than left to the agent:
        // `kind` is what get_job asks for by that name, and an album cannot be
        // polled at all without the design it belongs to.
        return (history.data ?? []).map((row) => ({
          job_id: row.id,
          kind: String(row.type ?? '').replace(/^job-/, '') || null,
          status: row.attributes?.status,
          building_id: row.relationships?.project?.data?.id ?? null,
          design_id: row.relationships?.concept?.data?.id ?? null,
          created_at: row.attributes?.created_at ?? null,
        }));
      },
    },

    {
      name: 'list_designs',
      title: 'List designs of a building',
      description:
        'All designs of a building with their renders. This is where the render ids for order_estimate, order_album and refine_design come from — `main_render_id` is the finished render of a design, null while nothing has finished, and `main_render_url` is its permanent public link (no signature, no expiry, safe to hand to a person, and not recallable once shared). Per-render state is not here: poll get_job for that.',
      schema: { building_id: z.string() },
      async handler({ building_id }) {
        const concepts = await api.get(`/projects/${building_id}/concepts`);

        // The listing carries render IDENTIFIERS, not render attributes, so a
        // `status` field here could only ever be null. A null status reads to
        // an agent as "not finished yet" and would send it back to poll a
        // render that is long done; get_job is the one place that knows.
        return (concepts.data ?? []).map((concept) => ({
          design_id: concept.id,
          note: concept.attributes?.note ?? null,
          has_main_render: concept.attributes?.has_main_render ?? false,
          main_render_id: concept.attributes?.main_render_id ?? null,
          main_render_url: concept.attributes?.main_render_url ?? null,
          renders: (concept.relationships?.renders?.data ?? []).map((render) => ({ id: render.id })),
        }));
      },
    },

    {
      name: 'order_estimate',
      title: 'Order a cost estimate',
      description:
        'Price the design, line by line, in materials and labour, for the renders you name. The figures come from the design itself: what the specified materials and build-up cost in this country. Currency and measurement system default to the building\'s country and the written text to the account language; do not guess any of them, omit them unless the caller asked for a specific one. The money follows the house, the words follow the reader: a building in one country can be priced in its own currency and still be written up in the language the person asking reads.',
      schema: {
        design_id: z.string(),
        building_id: z.string(),
        render_ids: z.array(z.string()).min(1),
        currency: z.string().length(3).optional(),
        measurement_system: z.enum(['metric', 'imperial']).optional(),
        language: z.string().optional().describe('Language of the written estimate, defaults to the account language'),
        special_requirements: z.string().max(3000).optional(),
      },
      async handler({ design_id, building_id, render_ids, currency, measurement_system, language, special_requirements }) {
        const estimate = await api.postPaid(`/projects/${building_id}/concepts/${design_id}/estimates`, {
          data: {
            type: 'estimate',
            attributes: {
              selected_renders: render_ids,
              currency,
              measurement_system,
              language,
              special_requirements,
            },
          },
        });

        return { job_id: estimate.data.id, status: estimate.data.attributes?.status };
      },
    },

    {
      name: 'order_album',
      title: 'Order a PDF album',
      description:
        'Document the design as a PDF album (the blueprint document) for the renders you name: the materials, the build-up of the facade, safety notes and the regulatory references behind them. This is the document a crew builds from. Name the `estimate_id` of the estimate whose prices belong in it: without one the album takes the newest finished estimate of the design, which is not necessarily the one that was just ordered. Requires a completed main render on that design, otherwise the API refuses with an explanation. `requirements` is not honoured on every account: when it is not, the album is still made and `notices` says so, in the API\'s own words. The finished album is a permanent public link, so it can be handed to a person as it stands, and it stays readable for anyone it is forwarded to.',
      schema: {
        design_id: z.string(),
        render_ids: z.array(z.string()).min(1),
        language: z.string().optional().describe('Album language, defaults to the account language'),
        include_blueprints: z.boolean().optional(),
        include_estimate: z.boolean().optional(),
        estimate_id: z.string().optional().describe('The finished estimate to price the album from'),
        requirements: z.string().max(2000).optional(),
      },
      async handler({ design_id, render_ids, language, include_blueprints, include_estimate, estimate_id, requirements }) {
        const album = await api.postPaid(`/concepts/${design_id}/album/generate`, {
          data: {
            type: 'album',
            attributes: {
              selected_renders: render_ids,
              language,
              include_blueprints,
              include_estimate,
              estimate_id,
              requirements,
            },
          },
        });

        const row = album.data ?? album;

        return {
          job_id: row.id,
          status: row.attributes?.status,
          // Server-written lines about what the order did NOT include (today:
          // custom `requirements` the account cannot use). Carried through
          // rather than dropped — a 202 with a silently ignored field reads to
          // an agent as "applied", and it would tell a person so.
          notices: album.meta?.notices ?? null,
        };
      },
    },

    {
      name: 'upscale_render',
      title: 'Upscale a render',
      description:
        'Enlarge a completed render to a higher resolution. Costs tokens like a render and runs asynchronously: poll the returned job with get_job. A render that is already upscaled, or not finished yet, is refused by the API with an explanation.',
      schema: {
        render_id: z.string(),
      },
      async handler({ render_id }) {
        const upscaled = await api.postPaid(`/renders/${render_id}/upscale`);
        const row = upscaled.data ?? upscaled;

        return { job_id: row?.id ?? render_id, status: row?.attributes?.status ?? null };
      },
    },

    {
      name: 'get_estimate',
      title: 'Read an estimate',
      description:
        'The finished estimate: its totals, the area and duration it assumes, and every line with its quantity, unit and price. This is the only way to see what was estimated — get_job reports the status of an estimate, never its content. The `unit` of a line is the display code to reuse in add_estimate_line.',
      schema: { estimate_id: z.string() },
      async handler({ estimate_id }) {
        const estimate = await api.get(`/estimates/${estimate_id}`);
        const attributes = estimate.data.attributes ?? {};

        return {
          estimate_id: estimate.data.id,
          status: attributes.status,
          title: attributes.title,
          currency: attributes.currency,
          measurement_system: attributes.measurement_system,
          facade_area: attributes.facade_area,
          facade_area_unit: attributes.facade_area_unit,
          estimated_duration_days: attributes.estimated_duration_days,
          materials_total: attributes.materials_total,
          labor_total: attributes.labor_total,
          grand_total: attributes.grand_total,
          // The three "has_" flags are the server's own answer to "is this
          // estimate still about the thing you are looking at". An agent that
          // ignores them can hand a client a price for renders that were since
          // replaced, so they travel with the totals rather than on request.
          is_edited: attributes.is_edited,
          has_newer_renders: attributes.has_newer_renders,
          has_diverged_facade_area: attributes.has_diverged_facade_area,
          notes: {
            dimensions: attributes.dimensions_notes ?? null,
            materials: attributes.materials_notes ?? null,
            labor: attributes.labor_notes ?? null,
          },
          lines: (estimate.included ?? [])
            .filter((row) => row.type === 'estimate_item')
            .map((row) => ({
              line_id: row.id,
              section: row.attributes?.section,
              category: row.attributes?.category ?? null,
              name: row.attributes?.name,
              quantity: row.attributes?.quantity,
              unit: row.attributes?.unit ?? null,
              unit_price: row.attributes?.unit_price,
              line_total: row.attributes?.line_total,
            })),
        };
      },
    },

    {
      name: 'add_estimate_line',
      title: 'Add a line to an estimate',
      description:
        'Add one line to a generated estimate. `unit` must be a display code of the estimate\'s own measurement system — read an existing line to see which codes it uses rather than guessing. Totals are recomputed by the server.',
      schema: {
        estimate_id: z.string(),
        section: z.enum(['materials', 'labor']),
        name: z.string().max(255),
        quantity: z.number().min(0),
        unit_price: z.number().min(0),
        unit: z.string().max(20).optional(),
        category: z.string().max(100).optional(),
      },
      async handler({ estimate_id, section, name, quantity, unit_price, unit, category }) {
        const created = await api.post(`/estimates/${estimate_id}/items`, {
          data: {
            type: 'estimate_item',
            attributes: { section, name, quantity, unit_price, unit, category },
          },
        });

        return { line_id: created.data.id };
      },
    },

    {
      name: 'update_estimate_line',
      title: 'Edit a line of an estimate',
      description:
        'Change one line of a generated estimate — its name, quantity, unit, unit price, category or section. Only the fields passed are changed. Totals are recomputed by the server.',
      schema: {
        estimate_id: z.string(),
        line_id: z.string(),
        name: z.string().max(255).optional(),
        quantity: z.number().min(0).optional(),
        unit_price: z.number().min(0).optional(),
        unit: z.string().max(20).optional(),
        category: z.string().max(100).optional(),
        section: z.enum(['materials', 'labor']).optional(),
      },
      async handler({ estimate_id, line_id, ...attributes }) {
        const updated = await api.patch(`/estimates/${estimate_id}/items/${line_id}`, {
          data: {
            type: 'estimate_item',
            id: line_id,
            attributes,
          },
        });

        return { line_id: updated?.data?.id ?? line_id };
      },
    },

    {
      name: 'delete_estimate_line',
      title: 'Remove a line from an estimate',
      description: 'Remove one line from a generated estimate. Totals are recomputed by the server.',
      schema: {
        estimate_id: z.string(),
        line_id: z.string(),
      },
      async handler({ estimate_id, line_id }) {
        await api.delete(`/estimates/${estimate_id}/items/${line_id}`);

        return { line_id, deleted: true };
      },
    },

    {
      name: 'delete_render',
      title: 'Delete a render',
      description:
        'Delete one render. Deleting the main render of a design returns that design to draft, so it can be rendered again without creating a new one. Deletion is soft on the server side and can be undone by a person in the app; this tool cannot undo it.',
      schema: {
        render_id: z.string(),
      },
      async handler({ render_id }) {
        await api.delete(`/renders/${render_id}`);

        return { render_id, deleted: true };
      },
    },

    {
      name: 'delete_design',
      title: 'Delete a design',
      description:
        'Delete one design (concept) of a building, with the renders under it. Deletion is soft on the server side and can be undone by a person in the app; this tool cannot undo it.',
      schema: {
        building_id: z.string(),
        design_id: z.string(),
      },
      async handler({ building_id, design_id }) {
        await api.delete(`/projects/${building_id}/concepts/${design_id}`);

        return { design_id, deleted: true };
      },
    },

    {
      name: 'delete_building',
      title: 'Delete a building',
      description:
        'Delete a building with everything under it: photos, designs, renders, estimates and albums. Deletion is soft on the server side and can be undone by a person in the app; this tool cannot undo it. Tokens already spent are not refunded.',
      schema: {
        building_id: z.string(),
      },
      async handler({ building_id }) {
        await api.delete(`/projects/${building_id}`);

        return { building_id, deleted: true };
      },
    },

    {
      name: 'list_token_packages',
      title: 'List the token packages',
      description:
        'The packages this account can buy, with their price and how many tokens each carries. Read this before buy_tokens instead of assuming a ladder — the packages and their prices change.',
      schema: {},
      async handler() {
        const packages = await api.get('/tokens/packages');

        return (packages.data ?? []).map((row) => ({
          package: row.id,
          tokens: row.attributes?.tokens,
          price: row.attributes?.price,
          currency: row.attributes?.currency,
        }));
      },
    },

    {
      name: 'buy_tokens',
      title: 'Buy tokens for this key',
      description:
        "Buy one token package for this key's wallet. Only works if the key was issued with purchasing enabled, and only up to what the key may still spend — a purchase cannot lift the key's own spend cap. The answer says `charged` when the payment provider took it from the saved payment method, or `requires_human` with a `checkout_url` a person has to open. Either way the tokens arrive asynchronously: poll get_balance.",
      schema: {
        package: z.string().max(20).describe('Package id from list_token_packages, e.g. "600"'),
      },
      async handler({ package: slug }) {
        // BILLING-CRITICAL: named and retried like every other paid call. This
        // one starts a real charge on a saved payment method, so a POST that
        // times out after the provider accepted it must come back as the same
        // purchase, not a second one.
        const started = await api.postPaid('/tokens/purchase', {
          data: {
            type: 'agent_token_purchase',
            attributes: { package: slug },
          },
        });

        return started.data?.attributes ?? started;
      },
    },

    {
      name: 'get_balance',
      title: 'Check the agent wallet',
      description:
        'What this key can still spend: the api-scope balance of the account and the cap of this key. `is_admissible` is the server\'s own answer to "will the next paid call be accepted" — read it instead of comparing the numbers yourself.',
      schema: {},
      async handler() {
        const balance = await api.get('/tokens/balance');
        const agent = balance.data?.attributes?.agent;

        if (!agent) {
          throw new Error('This key is not an agent key: the balance endpoint returned no agent wallet.');
        }

        return {
          scope: agent.scope,
          balance: agent.balance,
          limit: agent.key?.spend_cap,
          spent: agent.key?.spent,
          remaining: agent.key?.remaining,
          is_admissible: agent.is_admissible,
        };
      },
    },

    {
      name: 'report_problem',
      title: 'Report a problem with this API',
      description:
        'Report something wrong with this API itself: a field that is documented but never arrives, a refusal whose wording leaves no way forward, a call that only works on the second try, a result that does not match what was asked for. Free, and it works on an empty wallet, so a refusal can be reported the moment it happens. This is not the way to reach a person about an account or a charge, and no reply comes back through it; what comes back is a reference to quote. Say what was attempted, what was expected and what happened instead, and put the tool name and the ids in `context` so the report can be traced.',
      schema: {
        message: z.string().describe('What went wrong: what was attempted, what was expected, what happened instead'),
        category: z.enum(['bug_report', 'feature_request', 'technical_support']).optional().default('bug_report'),
        context: z
          .object({
            tool: z.string().optional().describe('The tool that misbehaved, e.g. "start_design"'),
            endpoint: z.string().optional(),
            status_code: z.number().int().optional(),
            job_id: z.string().optional().describe('Any id that identifies the case: a job, a design, a building'),
            expected: z.string().optional(),
            actual: z.string().optional(),
          })
          .optional(),
      },
      async handler({ message, category = 'bug_report', context }) {
        const filed = await api.post('/feedback', {
          data: {
            type: 'feedback',
            attributes: { message, category, ...(context ? { context } : {}) },
          },
        });

        return {
          reference: filed.data?.attributes?.reference ?? null,
          message: filed.data?.attributes?.message ?? null,
        };
      },
    },
  ];
}

/**
 * The one place this server waits. Validation is announced over a websocket the
 * agent does not have, so the documented polling point is used instead, and the
 * server's own `is_in_progress` flag decides when to stop asking — the set of
 * terminal statuses is not re-derived here (it has already grown four times).
 */
async function waitForValidation(api, angleId) {
  for (let attempt = 0; attempt < VALIDATION_POLL_ATTEMPTS; attempt += 1) {
    const attributes = (await api.get(`/angles/${angleId}/validation`)).data?.attributes ?? {};

    if (attributes.is_in_progress === false) {
      return {
        status: attributes.status,
        is_valid: attributes.is_valid,
        reason: attributes.validation_failure_reason ?? null,
        recommendations: attributes.recommendations ?? null,
      };
    }

    await sleep(VALIDATION_POLL_INTERVAL_MS);
  }

  return {
    status: 'pending',
    is_valid: null,
    // The registration leg keys on the file's md5 within the building, so the
    // same path re-registers the same view. Repeating the call is a resumed
    // wait, not a second photo.
    reason: 'Validation has not finished yet. Call upload_photo again with the same file to keep waiting: it resumes on this same view and uploads nothing twice.',
  };
}

/**
 * A render is addressed by the concept-angle row, not by the view. The create
 * response carries it as the `main_angle` relationship whenever the relation
 * was loaded; when it was not, the concept's own angle list answers the same
 * question (this is the path the end-to-end test walks).
 */
async function resolveMainConceptAngleId(api, concept) {
  const fromRelationship = concept.data?.relationships?.main_angle?.data?.id;

  if (fromRelationship) return fromRelationship;

  const angles = await api.get(`/concepts/${concept.data.id}/angles`);
  const first = (angles.data ?? [])[0];

  if (!first) {
    throw new Error('The created design has no view to render; check that the view belongs to this building.');
  }

  return first.id;
}

/**
 * A design is what a person names ("the one with the dark roof"), a render is
 * what refine mode iterates on. The concept listing is the only place that maps
 * one onto the other, and it reports `main_render_id` only once that render has
 * finished — which is exactly the eligibility rule refine mode enforces.
 */
async function resolveMainRenderId(api, buildingId, designId) {
  if (!buildingId) {
    throw new Error('Refining by `design_id` needs `building_id` as well — a design is addressed through its building.');
  }

  const concept = await api.get(`/projects/${buildingId}/concepts/${designId}`);
  const renderId = concept.data?.attributes?.main_render_id;

  if (!renderId) {
    throw new Error(`Design ${designId} has no finished render to refine yet; poll it with get_job and try again once it is done.`);
  }

  return renderId;
}
