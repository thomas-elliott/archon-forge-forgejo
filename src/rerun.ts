/**
 * Re-running failed checks on a pull request's head.
 *
 * Woodpecker reports each workflow of a pipeline as a commit status that links to the
 * pipeline, and it can only restart a whole pipeline, as a new one. So each pipeline
 * behind the selected statuses is restarted once, and its passing workflows run again
 * too. The new pipeline's number is each selected check's next attempt.
 *
 * Every selected check is confirmed before anything is restarted: still the latest
 * failed status of its context at the requested revision, linking to the pipeline it
 * was selected at, on the configured Woodpecker, for this repository and commit.
 */

import type { ForgeMutationRequest, ForgeResponse, SelectedCheck } from '@archon/forge/operations';
import { z } from 'zod';
import { errorDetail, type ForgejoApi, ForgejoError, namesRepo } from './api';
import { latestStatuses, linkedPipeline, observation } from './checks';
import { applied, type Submit, unverified } from './outcome';
import { readPull } from './pulls';
import { readWoodpeckerConfig, type WoodpeckerApi, woodpeckerRequest } from './woodpecker';

type RerunRequest = Extract<ForgeMutationRequest, { op: 'checks.rerun' }>;

interface Restart {
  repo: number;
  number: number;
  units: SelectedCheck[];
}

const FAILED_PIPELINE = ['failure', 'error', 'killed'];

const woodpeckerRepoSchema = z.object({ full_name: z.string() });
const pipelineSchema = z.object({
  number: z.number().int(),
  parent: z.number().int(),
  commit: z.string(),
  status: z.string(),
});

function refuse(kind: 'conflict' | 'unsupported_op', message: string): never {
  throw new ForgejoError({ kind, message }, true);
}

export async function rerunChecks(
  req: RerunRequest,
  api: ForgejoApi,
  submit: Submit,
  woodpeckerConfig: string | undefined
): Promise<ForgeResponse> {
  const woodpecker = await readWoodpeckerConfig(woodpeckerConfig, api.fetch);
  const head = (await readPull(api, req.ref)).head.sha;
  if (head !== req.revision)
    refuse('conflict', `Pull request head is ${head}, not ${req.revision}`);
  const restarts = await pipelinesToRestart(req, api, woodpecker);

  const observed: SelectedCheck[] = [];
  try {
    for (const restart of restarts)
      observed.push(...(await restartPipeline(req, woodpecker, restart, submit)));
  } catch (cause) {
    // With nothing restarted yet, the progress of the one write decides the outcome.
    if (observed.length === 0) throw cause;
    return unverified(
      req,
      errorDetail(cause).message,
      'the pipelines already restarted keep running, and the last restart may have started',
      { rerun: observed }
    );
  }
  return applied(req, { changed: true, ref: req.ref, revision: req.revision, units: observed });
}

/** The pipelines behind the selected checks, each confirmed failed at the requested revision. */
async function pipelinesToRestart(
  req: RerunRequest,
  api: ForgejoApi,
  woodpecker: WoodpeckerApi
): Promise<Restart[]> {
  const latest = await latestStatuses(api, req.ref.repo, req.revision);
  const restarts = new Map<string, Restart>();
  for (const selected of req.units) {
    const { unit, rerun } = selected;
    if (unit.kind !== 'commit_status' || !rerun || rerun.id !== unit.name)
      refuse('unsupported_op', `${unit.name} is not a Woodpecker check the plugin can re-run`);
    const status = latest.get(unit.name);
    const pipeline = status && linkedPipeline(status);
    if (
      !status ||
      !pipeline ||
      String(status.id) !== unit.id ||
      observation(status).state !== 'red' ||
      pipeline.number !== rerun.attempt
    )
      refuse(
        'conflict',
        `${unit.name} is not the latest failed check of pipeline ${String(rerun.attempt)} at ${req.revision}`
      );
    if (pipeline.origin !== woodpecker.origin)
      refuse(
        'unsupported_op',
        `${unit.name} links to ${pipeline.origin}, not the configured Woodpecker`
      );
    const key = `${String(pipeline.repo)}/${String(pipeline.number)}`;
    const restart = restarts.get(key) ?? {
      repo: pipeline.repo,
      number: pipeline.number,
      units: [],
    };
    restart.units.push(selected);
    restarts.set(key, restart);
  }

  for (const restart of restarts.values()) {
    const repo = await woodpeckerRequest(
      woodpecker,
      `/repos/${String(restart.repo)}`,
      woodpeckerRepoSchema
    );
    if (!namesRepo(repo.full_name, req.ref.repo))
      refuse(
        'conflict',
        `Woodpecker repository ${String(restart.repo)} is ${repo.full_name}, not ${req.ref.repo.path}`
      );
    const pipeline = await woodpeckerRequest(
      woodpecker,
      `/repos/${String(restart.repo)}/pipelines/${String(restart.number)}`,
      pipelineSchema
    );
    if (pipeline.commit !== req.revision || !FAILED_PIPELINE.includes(pipeline.status))
      refuse(
        'conflict',
        `Pipeline ${String(restart.number)} is ${pipeline.status} at ${pipeline.commit}, not failed at ${req.revision}`
      );
  }
  return [...restarts.values()];
}

/** Restart one pipeline and read the new one back; no query is sent, as Woodpecker turns a query into pipeline variables. */
async function restartPipeline(
  req: RerunRequest,
  woodpecker: WoodpeckerApi,
  restart: Restart,
  submit: Submit
): Promise<SelectedCheck[]> {
  const pipelines = `/repos/${String(restart.repo)}/pipelines`;
  submit('submitted');
  const started = await woodpeckerRequest(
    woodpecker,
    `${pipelines}/${String(restart.number)}`,
    pipelineSchema,
    { method: 'POST' },
    () => submit('acknowledged')
  );
  const pipeline = await woodpeckerRequest(
    woodpecker,
    `${pipelines}/${String(started.number)}`,
    pipelineSchema
  );
  if (
    pipeline.number <= restart.number ||
    pipeline.parent !== restart.number ||
    pipeline.commit !== req.revision
  )
    throw new ForgejoError({
      kind: 'invalid_response',
      message: `Restarted pipeline ${String(pipeline.number)} did not read back as a restart of ${String(restart.number)}`,
    });
  return restart.units.map(({ unit }) => ({
    unit,
    rerun: { id: unit.name, attempt: pipeline.number },
  }));
}
