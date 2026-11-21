/**
 * Labels: listing and ensuring a repository's labels, and adding or removing one
 * label on an issue or pull request.
 *
 * Forgejo's issue-label endpoints take label ids, and an item may carry the
 * repository's labels or its organization's, so a name is resolved across both.
 */

import type { RepoRef } from '@archon/forge';
import {
  contentDigest,
  type ForgeLabelRecord,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import { z } from 'zod';
import {
  type ForgejoApi,
  ForgejoError,
  ownerLabelsUrl,
  pages,
  repoUrl,
  request,
  send,
} from './api';
import { applied, type Submit, unverified } from './outcome';
import { labelNames, readIssue, subjectRecord } from './workitems';

const labelSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  color: z.string(),
  description: z.string(),
  exclusive: z.boolean().optional(),
});
type Label = z.infer<typeof labelSchema>;

/** The repository's labels followed by its organization's; a user-owned repository has none of the latter. */
async function availableLabels(api: ForgejoApi, repo: RepoRef): Promise<Label[]> {
  const own = await pages(api, repoUrl(api, repo, '/labels'), labelSchema);
  let shared: Label[] = [];
  try {
    shared = await pages(api, ownerLabelsUrl(api, repo), labelSchema);
  } catch (cause) {
    // Forgejo answers 404 when the owner is a user rather than an organization.
    if (!(cause instanceof ForgejoError && cause.detail.kind === 'not_found')) throw cause;
  }
  return [...own, ...shared];
}

/**
 * The one label named exactly `name`, case-sensitively, that an item in `repo` can carry.
 * Adding a label never creates one, so a missing name is refused, as is a name both
 * the repository and its organization hold.
 */
export async function existingLabel(api: ForgejoApi, repo: RepoRef, name: string): Promise<Label> {
  const matches = (await availableLabels(api, repo)).filter(label => label.name === name);
  if (matches.length === 0)
    throw new ForgejoError({ kind: 'not_found', message: `No label named ${name} exists` }, true);
  if (matches.length > 1)
    throw new ForgejoError(
      {
        kind: 'conflict',
        message: `Both the repository and its organization have a label named ${name}`,
      },
      true
    );
  return matches[0];
}

function labelRecord(label: Label): ForgeLabelRecord {
  return {
    name: label.name,
    color: label.color.replace(/^#/, '').toLowerCase(),
    descriptionDigest: contentDigest(label.description),
  };
}

/**
 * Whether a name has Forgejo's `scope/value` form: a slash with text on both sides.
 * Forgejo takes the scope as everything before the last slash.
 */
function isScoped(name: string): boolean {
  return /^.+\/.+$/.test(name);
}

export async function listRepoLabels(
  req: Extract<ForgeRequest, { op: 'repo.labels.list' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  const labels = await availableLabels(api, req.repo);
  return {
    operationId: req.operationId,
    ok: true,
    result: { op: req.op, value: { repo: req.repo, labels: labels.map(({ name }) => ({ name })) } },
  };
}

export async function ensureLabel(
  req: Extract<ForgeMutationRequest, { op: 'repo.label.ensure' }>,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  const existing = (await availableLabels(api, req.repo)).find(label => label.name === req.name);
  // An existing label keeps the color and description an operator gave it.
  if (existing) return applied(req, { changed: false, label: labelRecord(existing) });
  // A `scope/value` label is created exclusive, so adding one label of a scope drops
  // the others in one step: a claim is a single add. This is Forgejo-specific.
  const exclusive = isScoped(req.name);
  submit('submitted');
  const created = await request(
    api,
    repoUrl(api, req.repo, '/labels'),
    labelSchema,
    {
      method: 'POST',
      body: JSON.stringify({
        name: req.name,
        color: `#${req.color}`,
        description: req.description,
        exclusive,
      }),
    },
    () => submit('acknowledged')
  );
  const observed = await request(
    api,
    repoUrl(api, req.repo, `/labels/${String(created.id)}`),
    labelSchema
  );
  const label = labelRecord(observed);
  if (
    label.name !== req.name ||
    label.color !== req.color ||
    label.descriptionDigest !== contentDigest(req.description) ||
    (observed.exclusive ?? false) !== exclusive
  )
    return unverified(
      req,
      'Repository label read-back did not match',
      'a repository label may exist',
      { label }
    );
  return applied(req, { changed: true, label });
}

/** Add one label by id, never the whole set, so another writer's concurrent change survives. */
export async function postLabel(
  api: ForgejoApi,
  ref: { repo: RepoRef; number: number },
  id: number,
  submit: Submit
): Promise<void> {
  submit('submitted');
  await send(
    api,
    repoUrl(api, ref.repo, `/issues/${String(ref.number)}/labels`),
    { method: 'POST', body: JSON.stringify({ labels: [id] }) },
    () => submit('acknowledged')
  );
}

export async function addLabel(
  req: Extract<ForgeMutationRequest, { op: 'workitem.label.add' }>,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  const { subject, name } = req;
  const before = await readIssue(api, subject.ref);
  const workitem = subjectRecord(subject, before);
  if (labelNames(before).includes(name))
    return applied(req, { changed: false, workitem, labels: labelNames(before) });
  const label = await existingLabel(api, subject.ref.repo, name);
  await postLabel(api, subject.ref, label.id, submit);
  const after = await readIssue(api, subject.ref);
  const observed = subjectRecord(subject, after);
  // An exclusive scope drops the item's other label of that scope; only the added
  // label's presence is this write's to verify.
  return labelNames(after).includes(name)
    ? applied(req, { changed: true, workitem: observed, labels: labelNames(after) })
    : unverified(
        req,
        'Label read-back did not include the added label',
        'the label may be on the item',
        { workitem: observed }
      );
}

export async function removeLabel(
  req: Extract<ForgeMutationRequest, { op: 'workitem.label.remove' }>,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  const { subject, name } = req;
  const before = await readIssue(api, subject.ref);
  const workitem = subjectRecord(subject, before);
  // The item's own label carries the id, so no lookup across the repository is needed.
  const present = before.labels.find(label => label.name === name);
  if (!present) return applied(req, { changed: false, workitem, labels: labelNames(before) });
  const deleteLabel = (identifier: string) =>
    send(
      api,
      repoUrl(api, subject.ref.repo, `/issues/${String(subject.ref.number)}/labels/${identifier}`),
      { method: 'DELETE' },
      () => submit('acknowledged')
    );
  submit('submitted');
  let changed = true;
  try {
    try {
      await deleteLabel(String(present.id));
    } catch (cause) {
      // Forgejo looks an id up only among the repository's own labels, so an
      // organization label's id answers 422. It looks a name up among the
      // repository's labels and then the organization's, so the name removes it.
      if (!(cause instanceof ForgejoError && cause.detail.status === 422)) throw cause;
      await deleteLabel(encodeURIComponent(name));
    }
  } catch (cause) {
    // A concurrent writer removed it first. The read-back decides, and this call changed nothing.
    if (!(cause instanceof ForgejoError && cause.detail.kind === 'not_found')) throw cause;
    changed = false;
  }
  const after = await readIssue(api, subject.ref);
  const observed = subjectRecord(subject, after);
  return labelNames(after).includes(name)
    ? unverified(
        req,
        'Label read-back still included the removed label',
        'the label may have been removed',
        { workitem: observed }
      )
    : applied(req, { changed, workitem: observed, labels: labelNames(after) });
}
