# Issue tracker: GitHub

Issues and PRDs live in the GitHub repository `BrettKinny/UnKeep`. Repository
visibility is a release decision; agent workflows must not require it to remain
private. Use the GitHub connector or `gh` CLI for issue operations and infer the
repository from the local `origin` remote.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."`
- Close: `gh issue close <number> --comment "..."`

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket, read the GitHub issue and its comments.

Suspected vulnerabilities must use GitHub private vulnerability reporting as
described in `SECURITY.md`, not a public issue.
