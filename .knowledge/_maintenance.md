---
description: Knowledge base conventions — frontmatter format, when to create/update files, category structure
---

# Knowledge Base Maintenance

## Frontmatter Convention (Required)

Every knowledge file must start with YAML frontmatter containing a `description:` field:

```
---
description: One-line summary of what this file contains
---
```

The `description` is shown in the session-start index. Files without it are invisible to the index.

## When to Create or Update Knowledge

- **New pattern introduced** → create a file in the relevant category
- **Existing pattern changed** → update the affected file
- **Architectural decision made** → create a `decisions/` entry
- **Convention agreed on** → create a `conventions/` entry
- **File describes contents, not usage** → e.g., "Typed error contract and envelope format" not "Read this when handling errors"

## Categories

| Directory | What goes here |
|-----------|---------------|
| `architecture/` | System design, data flow, component structure, integration patterns |
| `conventions/` | Naming rules, code style, API patterns, error handling |
| `decisions/` | ADRs — why X was chosen over Y, with status |
| `subsystems/` | Deep dives into specific subsystems |
| `libraries/` | Key dependency usage, constraints, selection rationale |

## Quality Guidelines

- **200–800 words** per file — substantial, not stubs
- **Concrete file paths and code references** — not abstract descriptions
- **One topic per file** — prefer depth over breadth
- **Keep descriptions current** — outdated knowledge is worse than no knowledge
