---
description: Refresh the linked Altimate workspace's skills now and load them into this session.
---

Run this command with Bash and show the user its output:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/hooks-handlers/refresh-skills.sh" --wait
```

Skills the refresh adds or changes load into this session automatically. If the output says the project is not linked, or the command fails with `Not signed in to Altimate`, follow the `altimate-code` skill's "Altimate workspaces" section.
