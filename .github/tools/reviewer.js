// Minimal, pragmatic TypeScript-less JS to keep setup tiny
const { Octokit } = require("@octokit/rest");
const axios = require("axios");
const { z } = require("zod");

const model = "gpt-4o-mini"; // or gpt-4.1 if you have access

const schema = z.object({
  comments: z.array(z.object({
    path: z.string(),
    line: z.number().optional(),        // for unified diff positions
    start_line: z.number().optional(),  // for multi-line suggestions
    body: z.string(),
    suggestion: z.string().optional()   // code block to suggest
  })),
  tests: z.array(z.object({
    path: z.string(),
    content: z.string()
  })),
  docs: z.array(z.object({
    path: z.string(),
    content: z.string(),
    append: z.boolean().optional()      // append vs create/replace
  }))
});

async function openaiChat(messages) {
  const r = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    { model, messages, temperature: 0.2 },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );
  return r.data.choices[0].message.content;
}

function ghContext() {
  const ref = process.env.GITHUB_REF || "";
  const [ , , prNumber ] = ref.split("/");
  const repoFull = process.env.GITHUB_REPOSITORY; // owner/repo
  const [owner, repo] = repoFull.split("/");
  const pull_number = Number(process.env.GITHUB_EVENT_PULL_REQUEST_NUMBER || prNumber);
  return { owner, repo, pull_number };
}

async function main() {
  const { owner, repo, pull_number } = ghContext();
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number });
  const commitId = pr.head.sha;

  const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number, per_page: 100 });
  const diffs = files
    .filter(f => !f.filename.startsWith("dist/") && !f.filename.startsWith(".github/"))
    .map(f => ({ filename: f.filename, patch: f.patch || "" }))
    .filter(f => f.patch);

  // Grab README for repo context if exists
  let readme = "";
  try {
    const { data: rd } = await octokit.repos.getContent({ owner, repo, path: "README.md" });
    if ("content" in rd) readme = Buffer.from(rd.content, "base64").toString("utf8");
  } catch { /* ignore */ }

  if (!diffs.length) {
    console.log("No diffs with patches; exiting.");
    return;
  }

  const userMsg = [
    "Repo README:\n" + readme,
    "Changed files with unified diffs:",
    ...diffs.map(d => `\n=== ${d.filename} ===\n${d.patch}`)
  ].join("\n");

  const system = `You are a meticulous senior engineer.
Return strict JSON matching this schema:
{
 "comments":[{"path":string,"line"?:number,"start_line"?:number,"body":string,"suggestion"?:string}],
 "tests":[{"path":string,"content":string}],
 "docs":[{"path":string,"content":string,"append"?:boolean}]
}
Guidelines:
- Prefer small, actionable review comments tied to specific added lines.
- Where possible, include 'suggestion' with a minimal code fix.
- Generate minimal but valuable tests (unit or integration), place under tests/ or __tests__/ preserving project language.
- Draft or append docs for new/changed behaviors. Keep docs concise.
- Be terse. Avoid opinions without code or spec references.`;

  const content = await openaiChat([
    { role: "system", content: system },
    { role: "user", content: userMsg }
  ]);

  let parsed;
  try {
    parsed = schema.parse(JSON.parse(content));
  } catch (e) {
    console.error("Model output failed schema validation:", e?.message, content);
    return;
  }

  // Create a single review with comments
  const reviewComments = [];
  for (const c of parsed.comments) {
    reviewComments.push({
      path: c.path,
      body: c.suggestion
        ? `${c.body}\n\nSuggestion:\n\`\`\`\n${c.suggestion}\n\`\`\``
        : c.body,
      // Use 'position' for diff-relative line if available; fallback to side-comment on PR
      // For simplicity, try to find approximate position from patch:
      position: await approximatePosition(octokit, owner, repo, pull_number, c.path, c.line || 0)
    });
  }

  if (reviewComments.length) {
    await octokit.pulls.createReview({
      owner, repo, pull_number,
      event: "COMMENT",
      body: `Automated review for ${commitId.slice(0,7)}.`,
      comments: reviewComments.filter(c => c.position) // only ones we could anchor
    });
  }

  // Commit test/doc files as a new commit on the PR branch
  if (parsed.tests.length || parsed.docs.length) {
    // Get branch head tree
    const baseTree = (await octokit.git.getCommit({ owner, repo, commit_sha: commitId })).data.tree.sha;

    const blobs = [];
    for (const t of parsed.tests) {
      const { data } = await octokit.git.createBlob({ owner, repo, content: t.content, encoding: "utf-8" });
      blobs.push({ path: t.path, sha: data.sha });
    }
    for (const d of parsed.docs) {
      const { data } = await octokit.git.createBlob({ owner, repo, content: d.content, encoding: "utf-8" });
      blobs.push({ path: d.path, sha: data.sha });
    }

    const tree = await octokit.git.createTree({
      owner, repo, base_tree: baseTree,
      tree: blobs.map(b => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha }))
    });

    const commit = await octokit.git.createCommit({
      owner, repo,
      message: "chore: add tests/docs from automated review",
      tree: tree.data.sha,
      parents: [commitId]
    });

    await octokit.git.updateRef({
      owner, repo,
      ref: `heads/${pr.head.ref}`,
      sha: commit.data.sha,
      force: false
    });

    await octokit.issues.createComment({
      owner, repo, issue_number: pull_number,
      body: "I pushed proposed tests/docs. Feel free to edit or revert."
    });
  }

  console.log("Review complete.");
}

async function approximatePosition(octokit, owner, repo, pull_number, path, line) {
  // Minimal approach: fetch diff and count positions; if fails, return undefined
  try {
    const { data } = await octokit.pulls.get({ owner, repo, pull_number });
    const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number, per_page: 100 });
    const file = files.find(f => f.filename === path);
    if (!file || !file.patch) return undefined;
    let pos = 0, current = 0;
    for (const l of file.patch.split("\n")) {
      pos++;
      if (l.startsWith("+") && !l.startsWith("+++") ) current++;
      if (current === line) return pos;
    }
    return undefined;
  } catch { return undefined; }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
