---
title: Checking Smart Contracts for Price Manipulation Attacks
description: A practical way to check whether manipulated prices can push a smart contract into unsafe behavior.
canonicalPath: /projects/price-manipulation/
bodyClass: project-detail-page
navProjects: true
---

<section class="page-header project-page-header" aria-labelledby="project-title">
<p class="eyebrow">Smart contract security</p>
<h1 id="project-title">Checking Smart Contracts for Price Manipulation Attacks</h1>
<p class="project-lede">A practical way to find out whether someone can trick a smart contract by manipulating a market price.</p>
<div class="project-page-actions" aria-label="Project links">
<a class="button" href="mailto:hello@zhengwangyuan-patrick.com?subject=Price%20manipulation%20methodology">Request details</a>
<a href="/projects/">All projects</a>
</div>
</section>

<section class="project-detail" aria-label="Price manipulation methodology details">
<section class="project-detail-section">
<h2>Problem</h2>
<div>
<p>Some smart contracts act on prices that an attacker can influence. Even a short-lived price change can make the contract take an unsafe action.</p>
</div>
</section>

<section class="project-detail-section">
<h2>What I built</h2>
<div>
<ul class="project-detail-list">
<li>I start with a real attack or failure and write down what the attacker changed.</li>
<li>I turn the contract's expected behavior into checks for AMM reserves, oracle prices, collateral values, and other price-based decisions.</li>
<li>I use model checking to replay multi-step attacks and program analysis to find the related code.</li>
</ul>
</div>
</section>

<section class="project-detail-section">
<h2>What works today</h2>
<div>
<ul class="project-detail-list">
<li>Example attacks based on AMM and oracle price manipulation.</li>
<li>A clear link between each attack, the rule it breaks, and the check meant to catch it.</li>
<li>Failure traces that show what went wrong and where.</li>
</ul>
</div>
</section>
</section>
