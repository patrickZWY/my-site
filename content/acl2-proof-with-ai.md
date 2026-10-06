---
title: ACL2s proofs with AI
description: Practical experience using AI to develop and debug ACL2s proofs, with a downloadable agent skill.
canonicalPath: /writing/acl2-proof-with-ai/
bodyClass: writing-skill
---

<p class="eyebrow">3 &middot; Writing / Proof engineering</p>

# ACL2s proofs with AI

This skill grew out of hands-on work developing and debugging ACL2 and ACL2s proofs with AI assistance. AI helped propose helper lemmas and interpret failures; the prover checked whether each change actually worked.

The workflow that proved useful was:

1. **Start at the failing checkpoint.** Read the exact subgoal and its hypotheses, then identify the gap between its term shape and the available lemmas.
2. **Build a small bridge.** Add a helper that matches the checkpoint's constructors and branch conditions. Prove it separately, then use it in the larger theorem.
3. **Keep proof search focused.** Control rewrite rules, preserve useful canonical forms, and break nested induction into smaller obligations. For completeness claims, construct and verify an explicit witness.
4. **Check every iteration.** Make one proof change, run the prover with a time budget, and inspect the log. Finish by checking the full theorem chain in a fresh session.

The main lesson was that a missing bridge between equivalent expressions could matter more than another induction hint. Small, targeted lemmas made progress easier to explain and failures easier to diagnose.

The downloadable skill contains the detailed instructions, diagnostic commands, and reusable proof patterns for applying this workflow with an AI agent.

[Download SKILL.md](/skills/acl2-proof-with-ai/SKILL.md){download="SKILL.md"} · [Open SKILL.md](/skills/acl2-proof-with-ai/SKILL.md) · [Writing](/writing/)
