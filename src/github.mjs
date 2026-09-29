/**
 * GitHub API client for PR review automation.
 * Handles PR metadata resolution, stale-head protection, and COMMENT publication.
 */

const DEFAULT_API_BASE = 'https://api.github.com';

function getHeaders(token) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'docker-modal-pr-reviewer/0.1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Resolves PR metadata including head SHA, base SHA, and clone URL.
 */
export async function getPRMetadata({ owner, repo, prNumber, token, apiBase = DEFAULT_API_BASE }) {
  const url = `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}`;
  const res = await fetch(url, { headers: getHeaders(token) });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`GitHub API error fetching PR #${prNumber} (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  return {
    prNumber: data.number,
    title: data.title,
    baseSha: data.base.sha,
    headSha: data.head.sha,
    baseRef: data.base.ref,
    headRef: data.head.ref,
    isDraft: Boolean(data.draft),
    state: data.state,
    cloneUrl: data.head?.repo?.clone_url || data.base?.repo?.clone_url || `https://github.com/${owner}/${repo}.git`,
    htmlUrl: data.html_url,
  };
}

/**
 * Retrieves the current head SHA of a PR directly from GitHub.
 */
export async function getCurrentHead({ owner, repo, prNumber, token, apiBase = DEFAULT_API_BASE }) {
  const meta = await getPRMetadata({ owner, repo, prNumber, token, apiBase });
  return meta.headSha;
}

/**
 * Checks whether a review for this exact commit SHA and reviewer signature has already been posted.
 */
export async function checkAlreadyReviewed({
  owner,
  repo,
  prNumber,
  headSha,
  reviewerSignature = 'Docker + Modal PR Reviewer',
  token,
  apiBase = DEFAULT_API_BASE,
}) {
  const url = `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`;
  const res = await fetch(url, { headers: getHeaders(token) });

  if (!res.ok) {
    // If not accessible or 404, assume not reviewed
    return false;
  }

  const reviews = await res.json();
  if (!Array.isArray(reviews)) return false;

  return reviews.some(r =>
    r.commit_id === headSha &&
    typeof r.body === 'string' &&
    r.body.includes(reviewerSignature)
  );
}

/**
 * Safely publishes a COMMENT review with stale-commit protection.
 * If the current PR head no longer matches reviewedSha, publication is aborted.
 */
export async function safePublishReview({
  owner,
  repo,
  prNumber,
  reviewedSha,
  reviewBody,
  token,
  apiBase = DEFAULT_API_BASE,
}) {
  if (!token) {
    throw new Error('Cannot publish review: GITHUB_TOKEN is required');
  }

  // 1. Guard against race conditions: verify PR HEAD has not drifted
  const currentHead = await getCurrentHead({ owner, repo, prNumber, token, apiBase });
  if (currentHead !== reviewedSha) {
    return {
      published: false,
      reason: 'stale_head',
      message: `PR HEAD has changed from ${reviewedSha.slice(0, 8)} to ${currentHead.slice(0, 8)}. Review discarded.`,
    };
  }

  // 2. Publish COMMENT review
  const url = `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
  const payload = {
    commit_id: reviewedSha,
    body: reviewBody,
    event: 'COMMENT',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...getHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to publish GitHub review (${res.status}): ${errorText}`);
  }

  const reviewResult = await res.json();
  return {
    published: true,
    reviewId: reviewResult.id,
    htmlUrl: reviewResult.html_url,
  };
}
