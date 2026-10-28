---
type: llm
---
PASS if, without publishing anything, the reply asks the user to say which skill or skills to publish (or lists candidates for them to choose from). It still passes if the reply also reports a problem such as the CLI being missing.
FAIL if it says it published skills, or publishes without the user naming them, or never asks which skills to share.
