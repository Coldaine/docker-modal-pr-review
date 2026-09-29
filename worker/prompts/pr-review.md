Review Pull Request #{{PR_NUMBER}} at HEAD {{HEAD_SHA}} against base {{BASE_SHA}}.
The merge base is {{MERGE_BASE}}.

Your goal is to inspect the changes and find actionable defects introduced by this PR.

Guidelines:
1. Use `git diff {{MERGE_BASE}}..HEAD` to inspect all changes.
2. Read surrounding source files, callers, and tests to understand context.
3. If applicable, run targeted reproduction scripts or existing unit tests to verify any suspected defect.
4. Focus strictly on real defects, correctness bugs, security risks, broken contracts, or regressions introduced in this PR.
5. Do NOT post generic nitpicks, formatting comments, or trivial stylistic preferences.
6. Do NOT publish anything directly to GitHub.
7. Write your structured findings to `/workspace/review.json` strictly matching the schema below.

Required `/workspace/review.json` schema:
{
  "head_sha": "{{HEAD_SHA}}",
  "complete": true,
  "summary": "Short explanation of what was inspected and overall conclusions",
  "findings": [
    {
      "severity": "P0 | P1 | P2 | P3",
      "title": "Concise actionable finding title",
      "path": "path/to/file.ext",
      "line": 42,
      "description": "Clear explanation of the defect and why it fails",
      "evidence": "Concrete code snippet, error message, or test output"
    }
  ],
  "tests": [
    {
      "command": "command run if any",
      "result": "summary of command output and exit code"
    }
  ],
  "limitations": [
    "any tests or modules that could not be run or verified"
  ]
}
