---
name: acl2-proof-with-ai
description: Develop and debug ACL2 or ACL2s proofs with AI assistance using checkpoint-shaped lemmas, constructive witnesses, focused theories, and measured induction control. Use for failed theorem admissions or proof-search refactoring in an existing proof environment.
---

# ACL2 proofs with AI

This skill distills practical proof-debugging experience into instructions an AI agent can reuse. The central lesson: work from the prover's actual failing checkpoint, build the smallest useful bridge, and let ACL2 check every change.

## Working contract

- Inspect the target theorem, recursive definitions, admitted helper lemmas, loaded books, and ACL2/ACL2s version before changing the proof. Preserve the intended statement and assumptions.
- For exploratory changes, keep a recoverable baseline. Change one proof idea at a time and keep the last admitted theorem chain.
- Treat AI-generated lemmas and explanations as proposals. Report success only after the prover admits the intended theorem and its dependencies in a fresh run. Never replace a proof with an axiom, skipped proof, or weakened statement to make it pass.
- Keep a short dependency note beside a difficult theorem: which helper closes which checkpoint family, in what order.

## Checkpoint loop

1. Run the current proof with a short, configurable time budget. Thirty seconds was a useful iteration budget in the original experiments; choose a larger budget when the known baseline needs it.
2. Read the exact failing checkpoint and its hypotheses. Compare its constructors, operators, and branch conditions with the available lemmas.
3. Form one diagnosis: a missing hypothesis, constructor mismatch, erased canonical form, missing behavioral lemma, or unsuitable induction target.
4. Add or revise the smallest helper that addresses that diagnosis. Prove it separately before relying on it.
5. Re-run immediately. Record the changed lemma, admission result, remaining checkpoint, and elapsed time. Revert speculative changes that add no useful progress.

Repeated long runs are a reason to inspect term shape and the proof log. Avoid accumulating guessed lemmas or broadly enabling more rules.

For log inspection, adapt these commands to the local filenames and prover output:

```sh
rg -n '^\((property|defthm|definec|defun)\b' proof.lisp
rg -n 'Subgoal|checkpoint|FAILED|No induction schemes' proof.log
rg -c 'Perhaps we can prove .* by induction|We have been told to use induction' proof.log
rg -c 'Otherwise, this induction would have produced' proof.log
```

No matches in an `rg -c` query means zero matching lines; the command may exit with status 1. These are diagnostic counts, not proof certificates or portable performance measures. For a large log, isolate the target theorem's region before comparing counts.

Use a timeout mechanism that terminates the prover process and any children, retains the log, and reports timeout separately from admission failure. Do not infer proof success from a shell exit status alone: inspect the admission output and confirm the run reached the final target event.

## Match the proof shape

Build a helper in the form the checkpoint actually contains. Mathematically equivalent expressions can need different rewrite support.

- If the checkpoint extends an assignment with `(cons (cons key value) env)`, a helper stated only with `acons` may need a constructor bridge.
- If it uses a wrapper around `append`, state or instantiate a helper in that wrapper's form instead of assuming normalization will expose the library function.
- Separate constant conditions from variable conditions, and assigned-variable cases from unassigned-variable cases. Match the actual branch hypotheses.

Organize the proof as local behavior lemmas, then semantic bridges, then the target theorem. Give recursive helpers their own proof before asking the top-level theorem to combine several recursive arguments.

For reverse-and-accumulator goals, consider `revappend` as a canonical bridge. It can expose a better recursive driver than an expression assembled from reverse and append. Check the local definitions and list-domain hypotheses before choosing that form.

## Control rewriting

Enable only the definitions and rules needed for the current helper. If normalization rewrites the chosen canonical form away before its bridge can apply, disable that normalization rule locally while proving the bridge. An `e/d` theory expression can enable the required rules and disable the interfering ones; verify their names in the current environment.

For example, `acl2::revappend-removal` was an interfering normalization rule in the original experience. Its relevance depends on the loaded theory; do not assume every installation has the same rule enabled.

After a powerful bridge has served its purpose, consider disabling its automatic rewriting and supplying explicit instances through `:use`. Re-run later theorems to confirm that the narrower theory still supports them.

An equality whose proposed rewrite left side is a variable may be unsuitable as a rewrite rule. Keep such a result as a theorem with `:rule-classes nil` and use it explicitly; provide separate, oriented helper lemmas for automation. ACL2's [rule-classes documentation](https://acl2.org/doc/index-seo.php?xkey=ACL2____RULE-CLASSES) explains that this admits the theorem without installing rules.

## Diagnose induction

First establish a working proof with useful helpers. Refine induction hints afterward unless a missing induction scheme is already the immediate blocker.

When ACL2 reports “No induction schemes are suggested,” inspect the chosen term. Use a recursive driver with an applicable induction rule in the current logical world; a recursive function name alone does not guarantee a usable scheme for the supplied arguments.

For induction cascades:

1. Save a baseline log and locate repeated induction prompts and the “Otherwise, this induction would have produced” marker.
2. Identify the primary recursive driver and the checkpoint families that trigger secondary inductions.
3. Prove exact-shape bridges that let those families close by rewriting or explicit use.
4. Try a deliberate `:induct` on the primary driver together with `:do-not-induct t`, then inspect the blocked checkpoints.
5. If a checkpoint now fails, improve the corresponding helper before relaxing the restriction. Compare admission, elapsed time, and marker counts against the baseline.

When both hints apply to the same goal, ACL2 performs the requested induction and carries the prohibition into its generated subgoals. See the [ACL2 hints documentation](https://www.cs.utexas.edu/~moore/acl2/manuals/current/manual/index-seo.php?xkey=ACL2____HINTS). This is a targeted refactoring technique, not a requirement for every theorem.

## Reusable proof patterns

### Constructive completeness

For a checker and evaluator, a concrete witness can make the completeness direction easier to prove than a direct existence claim. Define the witness for a rejected input, prove that it satisfies the required assignment constraints, and prove that evaluation under that witness violates the claimed property.

Factor assignment preservation, lookup behavior, and branch selection into separate lemmas. For conditional expressions, cover constant conditions, assigned variables with each truth value, and unassigned variables whose assignments the witness extends. Then combine witness correctness with the soundness theorem to obtain the intended checker characterization.

### Canonical forms and uniqueness

When a sorting or normalization proof is tangled, try an identity lemma on the already-canonical domain. Combine it with output-canonicity and preservation lemmas to establish uniqueness and equivalence of implementations.

Equality of normal forms can be a useful relation, but justify that it captures the intended notion of equivalence. For list permutation, preserve multiplicities and connect the chosen normalization to the intended element order. Defining a relation by the algorithm being verified must not substitute for proving its specification.

### Counterexamples inside proof search

Check whether a reported counterexample satisfies the original theorem's hypotheses and falsifies its conclusion. If it does, revisit the statement or definitions. If it only falsifies a generalized internal clause, use it to diagnose which constraints or proof structure were lost.

When the log shows harmful generalization or related transformations, a focused `:do-not '(generalize eliminate-destructors fertilize)` hint may help. Disable only the processes implicated by the evidence and check the resulting checkpoint again.

## Finish with evidence

Run the complete dependency chain from a fresh prover session in the intended environment. Check that all target events were reached and admitted, with no skipped proofs or unresolved failures. If the task is proof-search refactoring, also compare the target region's induction diagnostics with the saved baseline.

Return the proof changes, the reason each important helper is needed, the actual prover command and environment, and the observed validation result. Distinguish admitted theorems from proposals that remain untested. For an unfinished proof, provide the remaining checkpoint and the next evidence-based diagnosis.
