// .github/tools/reviewer.js
// PR reviewer MVP with: JSON-mode output, repair fallback, rate-limit retries,
// config support, safer diff positioning, and a fallback to issue comment when
// inline review positions are rejected (422).

const { Octokit } = require("@octokit/rest");
const axios = require("axios");
const { z } = require("zod");

// ---------- Defaults (overridable via .copilot-reviewer/config.json)
let MODEL = "gpt-4o-mini";
let TEMPERATURE = 0.2;
let MAX_PATCH_CHARS = 20000;
let MAX_COMMENTS = 30;
let TARGET_GLOBS = ["src/**", "lib/**"];
let TESTS_ENABLED = true;
let DOCS_ENABLED = true;

// ---------- Zod schema for strict output
const SCHEMA = z.object({
  comments: z.array(z.object({
    path: z.string(),
    line: z.number().optional(),        // 1-based index among *added* lines in the file diff
    start_line: z.number().optional(),  // tolerated but unused here
    body: z.string(),
    suggestion: z.string().optional(),  // plain text code (no fences)
  })).max(100),
  tests: z.array(z.object({
    path: z.string(),
    content: z.string(),
  })),
  docs: z.array(z.object({
    path: z.string(),
    content: z.string(),
    append: z.boolean().optional(),
  })),
});

// ---------- Small utils
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function parseDurationSeconds(v) {
  if (!v) return 0;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const m = String(v).match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (!m) return 0;
  const [, h = 0, mn = 0, s = 0] = m.map(x => Number(x || 0));
  return h * 3600 + mn * 60 + s;
}
function waitSecondsFrom(headers, attempt) {
  const h = (n) => headers?.[n] || "";
  const retryAfter = parseDurationSeconds(h("retry-after"));
  const resetReq   = parseDurationSeconds(h("x-ratelimit-reset-requests"));
  const resetTok   = parseDurationSeconds(h("x-ratelimit-reset-tokens"));
  const exp = Math.min(60, 2 ** (attempt - 1)); // 1,2,4,8,16,32,60
  const jitter = Math.random();
  return Math.max(retryAfter, resetReq, resetTok, exp + jitter);
}

// ---------- OpenAI call with JSON mode + backoff (+ optional org header)
async function openaiChat(messages, { max_tokens = 2000 } = {}) {
  const body = {
    model: MODEL,
    messages,
    temperature: TEMPERATURE,
    max_tokens,
    response_format: { type: "json_object" },
  };
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (process.env.OPENAI_ORG_ID) headers["OpenAI-Organization"] = process.env.OPENAI_ORG_ID;

  const url = "https://api.openai.com/v1/chat/completions";
  const maxAttempts = 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await axios.post(url, body, { headers, timeout: 20000 });
      const content = r.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenAI: empty response content");
      return content;
    } catch (e) {
      const status = e.response?.status;
      const hdrs = e.response?.headers || {};
      const code = e.response?.data?.error?.code;
      const msg = e.response?.data?.error?.message || e.message;
      console.warn(`OpenAI error status ${status} code ${code}: ${msg}`);

      if (code === "insufficient_quota") {
        throw new Error("OpenAI insufficient_quota: check billing and API key quota");
      }
      if (status === 429 || (status >= 500 && status < 600)) {
        const wait = waitSecondsFrom(hdrs, attempt);
        console.warn(`Retrying in ~${wait.toFixed(1)}s attempt ${attempt}/${maxAttempts}`);
        await sleep(wait * 1000);
        continue;
      }
      throw e;
    }
  }
  throw new Error("OpenAI: exhausted retries");
}

// ---------- GitHub helpers
function githubContextFromEnv() {
  const repoFull = process.env.GITHUB_REPOSITORY;
  if (!repoFull) throw new Error("GITHUB_REPOSITORY not set");
  const [owner, repo] = repoFull.split("/");

  let pull_number;

  // Allow custom env or event payload (workflow_dispatch input)
  const prNumEnv = process.env.GITHUB_EVENT_PULL_REQUEST_NUMBER;
  if (prNumEnv) pull_number = Number(prNumEnv);

  try {
    const path = process.env.GITHUB_EVENT_PATH;
    if (path) {
      const ev = require(path);
      if (!pull_number && ev?.pull_request?.number) pull_number = Number(ev.pull_request.number);
      if (!pull_number && ev?.inputs?.pr)         pull_number = Number(ev.inputs.pr);
    }
  } catch { /* ignore */ }

  if (!pull_number) {
    const ref = process.env.GITHUB_REF || "";
    const parts = ref.split("/");
    const maybe = parts[2];
    if (maybe && /^\d+$/.test(maybe)) pull_number = Number(maybe);
  }

  if (!pull_number) throw new Error("Unable to determine PR number. For workflow_dispatch, pass inputs.pr");
  return { owner, repo, pull_number };
}

function globToRegex(glob) {
  // supports ** and * only
  let re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§§/g, ".*");
  return new RegExp("^" + re + "$");
}
function pathMatchesAny(path, globs) {
  if (!globs || !globs.length) return true;
  return globs.some(g => globToRegex(g).test(path));
}

async function getRepoTextFile(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    if (Array.isArray(data)) return "";
    if (!("content" in data)) return "";
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return "";
  }
}
async function getJSONConfig(octokit, owner, repo) {
  const raw = await getRepoTextFile(octokit, owner, repo, ".copilot-reviewer/config.json");
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { console.warn("config.json present but invalid JSON, ignoring"); return null; }
}
async function getPromptAddon(octokit, owner, repo) {
  return await getRepoTextFile(octokit, owner, repo, ".copilot-reviewer/prompt.md");
}

// For model input only (we send a trimmed diff to stay under token budgets)
function trimPatchForPrompt(patch) {
  if (!patch) return "";
  const filtered = patch.split("\n")
    .filter(l => l.startsWith("@@") || l.startsWith("+") || l.startsWith("-"))
    .join("\n");
  return filtered.slice(0, MAX_PATCH_CHARS);
}

// Build a mapping of nth added-line => absolute position in the unified diff
function buildAddedLinePositions(patch) {
  const positions = []; // positions[ (n-1) ] = diff position (1-based) of the nth '+' line
  if (!patch) return positions;
  let pos = 0;
  for (const line of patch.split("\n")) {
    pos++;
    // Note: positions count all lines (including @@ and context); we only record when the line is an actual '+'
    if (line.startsWith("+") && !line.startsWith("+++")) {
      positions.push(pos);
    }
  }
  return positions;
}
function positionFromNthAdded(patch, addedIndexOneBased) {
  if (!patch || !addedIndexOneBased || addedIndexOneBased < 1) return undefined;
  const arr = buildAddedLinePositions(patch);
  return arr[addedIndexOneBased - 1]; // undefined if out of range
}

// ---------- Main
async function main() {
  const { owner, repo, pull_number } = githubContextFromEnv();
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  // PR basics
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number });
  const headSha = pr.head.sha;
  const headRef = pr.head.ref;

  // Optional config & prompt
  const cfg = await getJSONConfig(octokit, owner, repo);
  if (cfg) {
    MODEL = cfg.model || MODEL;
    TEMPERATURE = typeof cfg.temperature === "number" ? cfg.temperature : TEMPERATURE;
    MAX_PATCH_CHARS = cfg.review?.maxPatchChars || MAX_PATCH_CHARS;
    MAX_COMMENTS = cfg.review?.maxComments || MAX_COMMENTS;
    TARGET_GLOBS = Array.isArray(cfg.review?.targetGlobs) ? cfg.review.targetGlobs : TARGET_GLOBS;
    TESTS_ENABLED = cfg.tests?.enabled !== undefined ? !!cfg.tests.enabled : TESTS_ENABLED;
    DOCS_ENABLED = cfg.docs?.enabled !== undefined ? !!cfg.docs.enabled : DOCS_ENABLED;
  }
  const promptAddon = await getPromptAddon(octokit, owner, repo);

  // Gather changed files
  const files = [];
  for (let page = 1; ; page++) {
    const { data } = await octokit.pulls.listFiles({ owner, repo, pull_number, per_page: 100, page });
    files.push(...data);
    if (data.length < 100) break;
  }

  // Prepare diffs for the model and for positioning
  const promptDiffs = [];
  const patchByPath = new Map();          // full patch from GitHub for positioning
  const addPosMapByPath = new Map();      // precomputed nth-added -> position map

  for (const f of files) {
    if (!f.patch) continue;               // very large diffs can have null patch
    if (f.status === "removed") continue;
    if (f.filename.startsWith(".github/")) continue;
    if (!pathMatchesAny(f.filename, TARGET_GLOBS)) continue;

    promptDiffs.push({ filename: f.filename, patch: trimPatchForPrompt(f.patch) });
    patchByPath.set(f.filename, f.patch);
    addPosMapByPath.set(f.filename, buildAddedLinePositions(f.patch));
  }

  if (!promptDiffs.length) {
    console.log("No eligible diffs to review");
    return;
  }

  // Light repo context for the model
  const readme  = await getRepoTextFile(octokit, owner, repo, "README.md");
  const pkg     = await getRepoTextFile(octokit, owner, repo, "package.json");
  const pyproj  = await getRepoTextFile(octokit, owner, repo, "pyproject.toml");
  const gomod   = await getRepoTextFile(octokit, owner, repo, "go.mod");

  const system = [
    "You are a meticulous senior engineer.",
    "Return strict JSON matching this schema:",
    '{ "comments":[{"path":string,"line"?:number,"start_line"?:number,"body":string,"suggestion"?:string}], "tests":[{"path":string,"content":string}], "docs":[{"path":string,"content":string,"append"?:boolean}] }',
    "Guidelines:",
    "- Limit to high-signal issues. Keep total comments under the supplied cap.",
    "- Tie each comment to a specific added line within the provided unified diffs.",
    "- Where reasonable, include a minimal 'suggestion' replacement block.",
    "- Generate minimal tests under tests/ or __tests__/ respecting the stack.",
    "- Create concise docs under docs/ or append to README.md if appropriate.",
    "- Be terse and actionable."
  ].join("\n");

  const capInfo = `Comment cap: ${Math.max(1, Math.min(MAX_COMMENTS, 60))}\nTests enabled: ${TESTS_ENABLED}\nDocs enabled: ${DOCS_ENABLED}`;

  const userMsg = [
    "Repository context:",
    capInfo,
    readme ? `README.md:\n${readme}` : "",
    pkg ? `package.json:\n${pkg}` : "",
    pyproj ? `pyproject.toml:\n${pyproj}` : "",
    gomod ? `go.mod:\n${gomod}` : "",
    "Changed files with unified diffs:",
    ...promptDiffs.map(d => `\n=== ${d.filename} ===\n${d.patch}`)
  ].join("\n");

  const extra = promptAddon ? [{ role: "system", content: promptAddon }] : [];
  const baseMessages = [
    { role: "system", content: system },
    ...extra,
    { role: "user", content: userMsg }
  ];

  // ---- Call model (JSON mode) and robustly parse
  let content = await openaiChat(baseMessages, { max_tokens: 2000 });

  let parsed;
  try {
    parsed = SCHEMA.parse(JSON.parse(content));
  } catch (err) {
    const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/```\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try { parsed = SCHEMA.parse(JSON.parse(fenceMatch[1])); } catch {}
    }
    if (!parsed) {
      console.warn("First parse failed; requesting a JSON-only reprint…", err?.message);
      const repairSystem = system + "\nReturn ONLY a valid JSON object (no code fences, no prose).";
      const repairMessages = [
        { role: "system", content: repairSystem },
        ...extra,
        { role: "user", content: userMsg + "\n\nYour last reply was invalid JSON. Reprint the SAME answer as valid JSON only." }
      ];
      const repaired = await openaiChat(repairMessages, { max_tokens: 2200 });
      parsed = SCHEMA.parse(JSON.parse(repaired));
    }
  }

  // Respect flags and caps
  if (!TESTS_ENABLED) parsed.tests = [];
  if (!DOCS_ENABLED) parsed.docs = [];
  if (parsed.comments.length > MAX_COMMENTS) parsed.comments = parsed.comments.slice(0, MAX_COMMENTS);

  // Prepare review comments (try inline first)
  const inlineComments = [];
  const fallbackSnippets = []; // for issue comment fallback

  for (const c of parsed.comments) {
    const path = c.path;
    const patch = patchByPath.get(path);
    const positionsArr = addPosMapByPath.get(path);
    const pos = c.line ? positionFromNthAdded(patch, c.line) : undefined;

    const suggestionBlock = c.suggestion ? `\n\n\`\`\`suggestion\n${c.suggestion}\n\`\`\`` : "";
    const bullet = `• ${path}${c.line ? ` (added line #${c.line})` : ""}\n${c.body}${suggestionBlock}`;
    fallbackSnippets.push(bullet);

    if (pos) {
      inlineComments.push({
        path,
        position: pos, // absolute position in the file's unified diff
        body: c.body + suggestionBlock,
      });
    }
  }

  // Try to post inline review; if it fails with 422, fall back to a single issue comment
  let inlinePosted = false;
  if (inlineComments.length) {
    try {
      await octokit.pulls.createReview({
        owner, repo, pull_number,
        event: "COMMENT",
        body: `Automated review for ${headSha.slice(0, 7)}.`,
        comments: inlineComments
      });
      inlinePosted = true;
    } catch (e) {
      if (e?.status === 422) {
        console.warn("Inline review rejected (422). Falling back to issue comment.");
      } else {
        console.warn("Inline review failed; falling back to issue comment.", e?.message || e);
      }
    }
  }

  if (!inlinePosted && fallbackSnippets.length) {
    const body = [
      `Unable to anchor inline comments to the diff (likely a diff context mismatch or truncated patch).`,
      `Here’s the review as a single comment instead:\n`,
      fallbackSnippets.join("\n\n")
    ].join("\n");
    await octokit.issues.createComment({
      owner, repo, issue_number: pull_number, body
    });
  }

  // Commit tests/docs to the PR branch
  if (parsed.tests.length || parsed.docs.length) {
    const blobs = [];

    for (const t of parsed.tests) {
      const { data } = await octokit.git.createBlob({ owner, repo, content: t.content, encoding: "utf-8" });
      blobs.push({ path: t.path, sha: data.sha });
    }
    for (const d of parsed.docs) {
      const { data } = await octokit.git.createBlob({ owner, repo, content: d.content, encoding: "utf-8" });
      blobs.push({ path: d.path, sha: data.sha });
    }

    const baseCommit = await octokit.git.getCommit({ owner, repo, commit_sha: headSha });
    const tree = await octokit.git.createTree({
      owner, repo, base_tree: baseCommit.data.tree.sha,
      tree: blobs.map(b => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha }))
    });

    const commit = await octokit.git.createCommit({
      owner, repo,
      message: "chore: add tests/docs from automated review",
      tree: tree.data.sha,
      parents: [headSha]
    });

    await octokit.git.updateRef({
      owner, repo,
      ref: `heads/${headRef}`,
      sha: commit.data.sha,
      force: false
    });

    await octokit.issues.createComment({
      owner, repo, issue_number: pull_number,
      body: "Pushed proposed tests/docs to the PR branch."
    });
  }

  console.log("Review complete");
}

// ---------- Run
main().catch(err => {
  console.error(err);
  process.exit(1);
});
