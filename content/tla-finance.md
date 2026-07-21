---
title: TLA-Finance
description: Model checking for investigating suspicious outputs from an agentic finance system.
canonicalPath: /projects/tla-finance/
bodyClass: project-detail-page
navProjects: true
---

<section class="page-header project-page-header" aria-labelledby="project-title">
<p class="eyebrow">Finance verification</p>
<h1 id="project-title">TLA-Finance</h1>
<p class="project-lede">A verification workbench for investigating suspicious outputs from an agentic finance system.</p>
<dl class="project-meta">
<div>
<dt>Tools / methods</dt>
<dd>TLA+</dd>
</div>
</dl>
<div class="project-page-actions" aria-label="Project links">
<a class="button" href="/demo/#tla-finance">Request a demo</a>
</div>
</section>

<section class="project-detail" aria-label="TLA-Finance details">
<section class="project-detail-section">
<h2>Problem</h2>
<div>
<p>An agentic finance system can produce output that appears plausible while conflicting with the financial state or constraints it was given. The challenge is to determine whether an output is actually suspicious and explain why.</p>
</div>
</section>

<section class="project-detail-section">
<h2>What I built</h2>
<div>
<ul class="project-detail-list">
<li>A workflow for turning a suspicious Finance Agent output and its relevant context into a reproducible verification case.</li>
<li>Formal constraints that describe what an acceptable output must preserve.</li>
<li>Trace-based analysis that connects a violated constraint back to the output and relevant state.</li>
</ul>
</div>
</section>

<section class="project-detail-section">
<h2>What works today</h2>
<div>
<ul class="project-detail-list">
<li>Case-driven evaluations centered on suspicious Finance Agent outputs.</li>
<li>A Choices construct for expressing and checking alternative Finance Agent decisions within the same verification case.</li>
<li>Model-checking results that show which modeled constraints hold or fail for each example.</li>
<li>An interactive walkthrough that explains a flagged output through its verification trace.</li>
</ul>
</div>
</section>
</section>
