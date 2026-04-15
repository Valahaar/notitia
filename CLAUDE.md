## Knowledge Base

This project maintains a self-updating knowledge base in `.knowledge/`.

**Before non-trivial changes:** scan the session-start index → read relevant files via the Read tool.
**After pattern changes:** update or create the relevant `.knowledge/*.md` file.

New knowledge files must start with frontmatter:
```
---
description: One-line summary (shown in the session index)
---
```

Categories: `architecture/`, `conventions/`, `decisions/`, `subsystems/`, `libraries/`

See `.knowledge/_maintenance.md` for the full convention guide.
