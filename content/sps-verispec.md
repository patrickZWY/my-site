---
title: SPS-VeriSpec
description: A Python tool that uses Soufflé rules to turn source-code facts into pytest tests.
canonicalPath: /projects/sps-verispec/
bodyClass: project-detail-page
navProjects: true
---

<section class="page-header project-page-header" aria-labelledby="project-title">
<p class="eyebrow">Automated testing</p>
<h1 id="project-title">SPS-VeriSpec</h1>
<p class="project-lede">A Python tool that reads source code, uses Soufflé rules to find useful relationships, and turns the strongest results into pytest tests.</p>
<div class="project-page-actions" aria-label="Project links">
<a class="button" href="https://github.com/patrickZWY/SPS-VeriSpec">View repository</a>
<a href="/demo/#sps-verispec">Request a demo</a>
<a href="/projects/">All projects</a>
</div>
</section>

<section class="project-detail" aria-label="SPS-VeriSpec details">
<section class="project-detail-section">
<h2>Problem</h2>
<div>
<p>Finding a pattern in source code does not automatically mean it makes a good test. The hard part is deciding which findings are reliable enough to run as pytest checks.</p>
</div>
</section>

<section class="project-detail-section">
<h2>What I built</h2>
<div>
<ul class="project-detail-list">
<li>A Python code reader that records classes, functions, calls, field access, exceptions, boundaries, and common dataclass patterns.</li>
<li>Soufflé rules that connect those facts and find useful relationships across the program.</li>
<li>A pytest generator that only promotes well-supported checks; uncertain or LLM-suggested results stay separate for human review.</li>
</ul>
</div>
</section>

<section class="project-detail-section">
<h2>What works today</h2>
<div>
<ul class="project-detail-list">
<li>Generated test suites and reports for CutePetsBoston, dacite, bounded Transformers, and a type-checker case study.</li>
<li>Reusable checks for dataclass fields, constructors, default values, and conversions.</li>
<li>A browser view that shows the path from source facts to Soufflé results, generated tests, validation, and items that still need review.</li>
</ul>
</div>
</section>
</section>
