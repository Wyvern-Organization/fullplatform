export const DISCORD_URL = 'https://discord.gg/NSHjB5P8w';

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #000; --panel: #0a0a0a;
  --line: rgba(255,255,255,.1); --line-soft: rgba(255,255,255,.06);
  --text: #fff; --soft: rgba(255,255,255,.72); --muted: rgba(255,255,255,.46);
  --green: #34d17e; --page-w: 1080px;
}
html { scroll-behavior: smooth; }
body { min-height: 100vh; background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
a { color: inherit; text-decoration: none; }
.page { max-width: var(--page-w); margin: 0 auto; padding: 0 28px 72px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 26px 0; border-bottom: 1px solid var(--line-soft); }
.brand { font-size: 15px; font-weight: 650; letter-spacing: .22em; text-transform: uppercase; }
.nav { display: flex; align-items: center; gap: 30px; font-size: 13.5px; color: var(--soft); }
.nav a { transition: color .18s ease; }
.nav a:hover { color: var(--text); }
.nav-cta { border: 1px solid var(--line); border-radius: 999px; padding: 9px 16px; color: var(--text); font-size: 13px; transition: background .18s ease, border-color .18s ease; }
.nav-cta:hover { background: var(--text); border-color: var(--text); color: #000; }
.nav-cta-solid { background: var(--text); color: #000; border-color: var(--text); }
.nav-cta-solid:hover { background: rgba(255,255,255,.85); }
.hero { padding: clamp(80px, 12vw, 132px) 0 clamp(48px, 6vw, 80px); max-width: 860px; }
.kicker { display: inline-flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: .18em; text-transform: uppercase; }
.kicker::before { content: ""; width: 26px; height: 1px; background: var(--muted); }
h1 { margin-top: 28px; font-size: clamp(46px, 8vw, 92px); line-height: .96; font-weight: 550; letter-spacing: -.05em; }
h1.sub { font-size: clamp(34px, 5.5vw, 60px); }
h1 .dim { color: var(--muted); font-weight: 400; }
.lede { margin-top: 26px; max-width: 600px; color: var(--soft); font-size: clamp(16px, 1.8vw, 19px); line-height: 1.75; font-weight: 400; }
.lede strong { color: var(--text); font-weight: 600; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 36px; }
.button { display: inline-flex; align-items: center; gap: 10px; border: 1px solid var(--line); border-radius: 999px; padding: 12px 21px; font-size: 14px; font-weight: 550; background: transparent; color: var(--text); transition: background .18s ease, border-color .18s ease; }
.button:hover { border-color: var(--text); }
.button-primary { background: var(--text); color: #000; border-color: var(--text); }
.button-primary:hover { background: rgba(255,255,255,.85); }
.button-sm { padding: 8px 15px; font-size: 13px; }
section { padding: 54px 0 10px; }
.sec-head { display: flex; align-items: baseline; gap: 22px; margin-bottom: 30px; border-top: 1px solid var(--line-soft); padding-top: 30px; }
.sec-index { color: var(--muted); font-size: 12.5px; font-weight: 600; font-family: "SF Mono", Consolas, monospace; }
h2 { font-size: clamp(28px, 4.4vw, 44px); font-weight: 520; letter-spacing: -.035em; }
h3 { font-size: 16px; font-weight: 600; letter-spacing: .01em; }
.mission { border: 1px solid var(--line-soft); background: var(--panel); padding: clamp(28px, 4vw, 46px); }
.mission p { color: var(--soft); font-size: clamp(17px, 2.1vw, 22px); line-height: 1.7; max-width: 880px; font-weight: 350; }
.mission strong { color: var(--text); font-weight: 600; }
.criteria-note { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line-soft); color: var(--muted); font-size: 14px; line-height: 1.7; }
.criteria-note strong { color: var(--soft); font-weight: 600; }
.table { border-top: 1px solid var(--line); }
.table-row { display: grid; grid-template-columns: 200px 1fr; gap: 26px; padding: 22px 4px; border-bottom: 1px solid var(--line-soft); align-items: baseline; }
.tier-label { display: flex; align-items: center; gap: 12px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--green); box-shadow: 0 0 12px rgba(52,209,126,.55); flex: none; }
.tier-label .name { font-size: 16px; font-weight: 600; letter-spacing: .01em; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; }
.badge { font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; color: var(--soft); }
.badge-gold { border-color: rgba(255,255,255,.35); color: var(--text); }
.table-row p { color: var(--soft); font-size: 14.5px; line-height: 1.7; max-width: 640px; }
.panel { border: 1px solid var(--line-soft); background: var(--panel); padding: clamp(24px, 4vw, 40px); }
.form { display: grid; gap: 18px; max-width: 560px; }
.field { display: grid; gap: 8px; }
.field label { font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.field input, .field textarea, .field select {
  width: 100%; background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
  color: var(--text); padding: 12px 14px; font-size: 15px; font-family: inherit; outline: none;
  transition: border-color .18s ease;
}
.field input:focus, .field textarea:focus, .field select:focus { border-color: rgba(255,255,255,.4); }
.field textarea { resize: vertical; min-height: 90px; }
.field .hint { color: var(--muted); font-size: 12.5px; line-height: 1.6; }
.form .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.form-note { color: var(--muted); font-size: 13px; line-height: 1.7; }
.form-note a { color: var(--soft); text-decoration: underline; text-underline-offset: 3px; }
.msg { font-size: 14px; line-height: 1.6; }
.msg.ok { color: var(--green); }
.msg.err { color: #ff7b72; }
.grid { display: grid; gap: 1px; background: var(--line-soft); border: 1px solid var(--line-soft); }
.grid-3 { grid-template-columns: repeat(3, 1fr); }
.card { background: var(--bg); padding: 26px; display: flex; flex-direction: column; gap: 14px; transition: background .2s ease; }
.card:hover { background: var(--panel); }
.card .index { color: var(--muted); font-size: 11.5px; font-family: "SF Mono", Consolas, monospace; letter-spacing: .08em; }
.card p { color: var(--soft); font-size: 14px; line-height: 1.7; }
.card .tag { margin-top: auto; padding-top: 8px; color: var(--muted); font-size: 11px; font-family: "SF Mono", Consolas, monospace; border-top: 1px solid var(--line-soft); letter-spacing: .04em; }
.project-title { display: flex; align-items: baseline; gap: 14px; }
.catalog-empty { color: var(--muted); font-size: 15px; padding: 40px 4px; border: 1px dashed var(--line); text-align: center; border-radius: 12px; }
.entry { border: 1px solid var(--line-soft); background: var(--panel); padding: 24px; display: grid; gap: 14px; }
.entry + .entry { margin-top: 14px; }
.entry .entry-head { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.entry .entry-head h3 { font-size: 19px; font-weight: 600; }
.entry .entry-links { display: flex; flex-wrap: wrap; gap: 8px; }
.entry .entry-links a { font-size: 12.5px; font-family: "SF Mono", Consolas, monospace; color: var(--soft); border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; transition: border-color .18s ease, color .18s ease; }
.entry .entry-links a:hover { border-color: rgba(255,255,255,.4); color: var(--text); }
.entry .desc { color: var(--soft); font-size: 14.5px; line-height: 1.7; }
.entry .meta { color: var(--muted); font-size: 12px; font-family: "SF Mono", Consolas, monospace; }
.chip { font-size: 12.5px; font-weight: 600; white-space: nowrap; border: 1px solid var(--line); border-radius: 999px; padding: 6px 13px; color: var(--soft); }
.chip.pos { color: var(--text); border-color: rgba(52,209,126,.4); background: rgba(52,209,126,.06); }
.chip.gold { color: #000; background: var(--text); border-color: var(--text); }
.chip.neg { color: var(--muted); }
.toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 24px; }
.tabs { display: flex; gap: 8px; }
.tab { font-size: 13px; font-weight: 600; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 8px 16px; transition: color .18s ease, border-color .18s ease; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-color: rgba(255,255,255,.45); }
.su { border: 1px solid var(--line-soft); background: var(--panel); }
.su-row { padding: 20px 24px; border-bottom: 1px solid var(--line-soft); display: grid; gap: 12px; }
.su-row:last-child { border-bottom: 0; }
.su-head { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; }
.su-head .id { color: var(--muted); font-size: 12px; font-family: "SF Mono", Consolas, monospace; }
.su-head .date { color: var(--muted); font-size: 12px; font-family: "SF Mono", Consolas, monospace; }
.su-name { font-size: 17px; font-weight: 600; }
.su-desc { color: var(--soft); font-size: 14px; line-height: 1.7; }
.su-links { display: flex; flex-wrap: wrap; gap: 8px; }
.su-links a { font-size: 12px; font-family: "SF Mono", Consolas, monospace; color: var(--soft); border: 1px solid var(--line); border-radius: 999px; padding: 5px 11px; }
.su-links a:hover { border-color: rgba(255,255,255,.4); color: var(--text); }
.su-links span.nolink { font-size: 12px; font-family: "SF Mono", Consolas, monospace; color: var(--muted); border: 1px dashed var(--line); border-radius: 999px; padding: 5px 11px; }
.label-checks { display: flex; flex-wrap: wrap; gap: 8px; }
.label-check { display: inline-flex; align-items: center; gap: 8px; font-size: 13.5px; color: var(--soft); border: 1px solid var(--line); border-radius: 999px; padding: 8px 14px; cursor: pointer; user-select: none; transition: border-color .18s ease, color .18s ease; }
.label-check input { accent-color: var(--green); }
.label-check:has(input:checked) { border-color: rgba(52,209,126,.5); color: var(--text); }
.su-notes textarea { width: 100%; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; color: var(--text); padding: 10px 13px; font-size: 14px; font-family: inherit; outline: none; resize: vertical; }
.su-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.spinner { color: var(--muted); font-size: 14px; }
.loading { color: var(--muted); font-size: 14px; padding: 40px 0; }
.muted { color: var(--muted); }
footer { margin-top: 64px; padding-top: 26px; border-top: 1px solid var(--line-soft); color: var(--muted); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 10px 26px; align-items: center; justify-content: space-between; letter-spacing: .03em; }
footer .foot-links { display: flex; gap: 22px; }
footer a { transition: color .18s ease; }
footer a:hover { color: var(--text); }
@media (max-width: 860px) { .grid-3 { grid-template-columns: 1fr; } .table-row { grid-template-columns: 1fr; gap: 10px; } }
@media (max-width: 640px) { .page { padding: 0 20px 56px; } .nav { display: none; } .topbar { padding: 20px 0; } }
.skip{position:fixed;left:1rem;top:-5rem;background:#fff;color:#000;padding:.7rem 1rem;border-radius:.5rem;z-index:20}
.skip:focus{top:1rem}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--green);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;transition-duration:.01ms!important}
@media (forced-colors:active){*{border-color:CanvasText!important}}

`;

export function layout(body: string, opts: { title: string; active?: string; script?: string }): string {
  const nav = [
    ['#mission', 'Mission'],
    ['/catalog', 'Catalog'],
    ['/submit', 'Submit'],
  ];
  const tabs = nav.map(([href, label]) => `<a class="nav ${opts.active === label ? '' : ''}" href="${href}">${label}</a>`).join('');
  const navLinks = nav
    .map(([href, label]) => `<a href="${href}" ${opts.active === label ? 'style="color:var(--text)"' : ''}>${label}</a>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#000000" />
<meta name="color-scheme" content="dark light" />
<meta name="description" content="OSAII — the Open-Source AI Initiative. We certify whether models are open, and release open models ourselves. Part of OSAII Platform with API, Studio, Masque, Cosaii, MythOS." />
<meta property="og:title" content="${opts.title} — OSAII" />
<meta property="og:description" content="OSAII Platform — certification, API, Studio, Masque, MythOS, Cosaii." />
<meta property="og:image" content="/osaii.png" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary" />
<link rel="canonical" href="https://osaii.wyvernhub.net${opts.active === 'Mission' ? '/initiative' : opts.active === 'Catalog' ? '/catalog' : ''}" />
<link rel="manifest" href="/studio/new/manifest.webmanifest" />
<link rel="icon" href="/osaii.png" type="image/png" />
<title>${opts.title} — OSAII Platform</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="page">
  <header class="topbar" role="banner">
    <a class="brand" href="/" aria-label="OSAII Platform home">OSAII</a>
    <nav class="nav" aria-label="Primary">${navLinks} <a href="/products">Products</a> <a href="/docs">Docs</a></nav>
    <a class="nav-cta" href="/signin">Auditor sign in</a>
    <a class="nav-cta nav-cta-solid" href="/submit">Submit a model ↗</a>
  </header>
  <main id="main">
  ${body}</main>
  <footer role="contentinfo">
    <span>© <span id="year"></span> OSAII Platform · Open-Source AI Initiative</span>
    <div class="foot-links" aria-label="Footer">
      <a href="${DISCORD_URL}" target="_blank" rel="noopener">Discord</a>
      <a href="/catalog">Catalog</a>
      <a href="/products">Products</a>
      <a href="/docs">Docs</a>
      <a href="/masque">Masque</a>
      <a href="/mythos">MythOS</a>
      <a href="/signin">Auditors</a>
      <a href="/health">Health</a>
    </div>
  </footer>
</div>
<script>document.getElementById('year').textContent = new Date().getFullYear();${opts.script ?? ''}</script>
</body>
</html>`;
}

export function homepage(): string {
  return `
<section class="hero">
  <span class="kicker">Open-Source AI Initiative</span>
  <h1>The OSI,<br /><span class="dim">for AI.</span></h1>
  <p class="lede">
    OSAII is the certification body for open AI — and a builder of it. We determine
    whether models are genuinely open, and publish the verdicts. <strong>Open weights
    or open data qualifies.</strong> Both are not required.
  </p>
  <div class="hero-actions">
    <a class="button button-primary" href="/submit">Submit a model for review</a>
    <a class="button" href="/catalog">Browse the catalog</a>
  </div>
</section>

<section id="mission">
  <div class="sec-head"><span class="sec-index">01</span><h2>Mission</h2></div>
  <div class="mission">
    <p>
      The Open Source Initiative defined what "open source software" means. OSAII does
      the same for AI: a neutral body that <strong>certifies whether models are open</strong>
      against a clear, public standard — and releases its own open models where the
      ecosystem needs them.
    </p>
    <p class="criteria-note">
      <strong>Compatibility:</strong> a model is OSAII-compatible when it is open in at
      least one of the three dimensions below. Verdicts are published, versioned, and
      never for sale.
    </p>
  </div>
</section>

<section id="tiers">
  <div class="sec-head"><span class="sec-index">02</span><h2>Compatibility tiers</h2></div>
  <div class="table">
    <div class="table-row"><div class="tier-label"><span class="dot"></span><span class="name">Open Weights</span></div><p>The model weights are publicly available.</p></div>
    <div class="table-row"><div class="tier-label"><span class="dot"></span><span class="name">Open Code</span></div><p>The training and/or inference code is publicly available and reproducible.</p></div>
    <div class="table-row"><div class="tier-label"><span class="dot"></span><span class="name">Open Data</span></div><p>The training dataset (or a reproducible equivalent) is publicly available.</p></div>
    <div class="table-row"><div class="tier-label"><span class="dot"></span><span class="name">Open Source</span><span class="badges"><span class="badge badge-gold">OSAII Approved</span></span></div><p>Meets all three: Open Weights + Open Code + Open Data.</p></div>
  </div>
</section>

<section id="catalog">
  <div class="sec-head"><span class="sec-index">03</span><h2>Certified catalog</h2></div>
  <div id="catalog-preview"><div class="loading">Loading catalog…</div></div>
</section>
`;
}

export function submitPage(): string {
  return `
<section class="hero" style="padding-bottom:40px">
  <h1 class="sub">Submit a model<span class="dim">.</span></h1>
  <p class="lede">Tell us where a model's weights, code, and/or data live. An auditor will verify
    and assign its OSAII label. <strong>One link is enough</strong> to start — anything you provide
    becomes part of the public record.</p>
</section>
<section>
  <div class="panel">
    <form class="form" id="submit-form">
      <div class="field"><label for="name">Model name</label><input id="name" name="name" type="text" required maxlength="120" placeholder="e.g. Aurora 3B" /></div>
      <div class="field"><label for="description">Short description</label><textarea id="description" name="description" maxlength="600" placeholder="What is it, and why did you build it?"></textarea></div>
      <div class="field"><label for="email">Submitter email</label><input id="email" name="email" type="email" placeholder="you@example.com" /></div>
      <div class="field"><label for="license">License</label><input id="license" name="license" type="text" maxlength="60" placeholder="e.g. Apache-2.0" /></div>
      <div class="field"><label for="website">Project page</label><input id="website" name="website" type="url" placeholder="https://…" /></div>
      <div class="field"><label for="weights">Weights URL</label><input id="weights" name="weights" type="url" placeholder="https://huggingface.co/…" /></div>
      <div class="field"><label for="code">Code URL</label><input id="code" name="code" type="url" placeholder="https://github.com/…" /></div>
      <div class="field"><label for="data">Data URL</label><input id="data" name="data" type="url" placeholder="https://… / dataset" /></div>
      <div class="actions">
        <button class="button button-primary" type="submit">Submit for review</button>
        <span class="form-note">Public submission — your links and description enter the review queue.</span>
      </div>
      <div class="msg" id="form-msg" hidden></div>
    </form>
  </div>
</section>`;
}

export function catalogPage(): string {
  return `
<section class="hero" style="padding-bottom:40px">
  <h1 class="sub">Certified catalog<span class="dim">.</span></h1>
  <p class="lede">Models independently verified by OSAII auditors. Each entry carries its
    official labels and links to the weights, code, or data behind it.</p>
</section>
<section>
  <div id="catalog-list"><div class="loading">Loading catalog…</div></div>
</section>`;
}

export function signinPage(): string {
  return `
<section class="hero" style="padding-bottom:40px">
  <h1 class="sub">Auditor sign in<span class="dim">.</span></h1>
  <p class="lede">Access the review queue and label submissions. Auditors only — if you haven't
    been invited, the public form is <a href="/submit" style="text-decoration:underline;text-underline-offset:3px;color:var(--soft)">here</a>.</p>
</section>
<section>
  <div class="panel">
    <form class="form" id="signin-form">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email" /></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password" /></div>
      <div class="actions">
        <button class="button button-primary" type="submit">Sign in</button>
        <span class="form-note">Signed in? <a href="/audit">Open the dashboard.</a></span>
      </div>
      <div class="msg" id="form-msg" hidden></div>
    </form>
  </div>
</section>`;
}

export function signupPage(codeValid: boolean): string {
  if (!codeValid) {
    return `
<section class="hero" style="padding-bottom:40px">
  <h1 class="sub">Private link<span class="dim">.</span></h1>
  <p class="lede">This page is invite-only. If you were sent a signup link, open it from the
    original message.</p>
</section>`;
  }
  return `
<section class="hero" style="padding-bottom:40px">
  <h1 class="sub">Become an auditor<span class="dim">.</span></h1>
  <p class="lede">You were invited. Create an account to access the review queue and label
    submissions against the OSAII tiers.</p>
</section>
<section>
  <div class="panel">
    <form class="form" id="signup-form">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email" /></div>
      <div class="field"><label for="name">Name</label><input id="name" name="name" type="text" maxlength="60" autocomplete="name" /></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required minlength="8" autocomplete="new-password" /><span class="hint">At least 8 characters.</span></div>
      <div class="actions">
        <button class="button button-primary" type="submit">Create auditor account</button>
      </div>
      <div class="msg" id="form-msg" hidden></div>
    </form>
  </div>
</section>`;
}

export function auditPage(): string {
  return `
<section class="hero" style="padding-bottom:40px">
  <h1 class="sub">Audit queue<span class="dim">.</span></h1>
  <p class="lede">Review submissions, assign labels, and publish verdicts to the catalog.</p>
</section>
<section>
  <div class="toolbar">
    <div class="tabs">
      <a class="tab active" data-status="pending" href="?status=pending">Pending</a>
      <a class="tab" data-status="labeled" href="?status=labeled">Labeled</a>
      <a class="tab" data-status="rejected" href="?status=rejected">Rejected</a>
    </div>
    <a class="button button-sm" href="/api/auth/signout" data-signout>Sign out</a>
  </div>
  <div id="audit-list"><div class="loading">Loading queue…</div></div>
</section>`;
}

export const catalogClient = `
function chips(s) {
  if (s.closed) return '<span class="chip neg">Fully Closed</span><span class="chip neg">No OSAII label</span>';
  var out = (s.summary || []).map(function (l) { return '<span class="chip pos">' + l + '</span>'; }).join('');
  return out;
}
function entryHtml(s) {
  var links = [];
  if (s.website_url) links.push('<a href="' + s.website_url + '" target="_blank" rel="noopener">site</a>');
  if (s.weights_url) links.push('<a href="' + s.weights_url + '" target="_blank" rel="noopener">weights</a>');
  if (s.code_url) links.push('<a href="' + s.code_url + '" target="_blank" rel="noopener">code</a>');
  if (s.data_url) links.push('<a href="' + s.data_url + '" target="_blank" rel="noopener">data</a>');
  if (s.license) links.push('<span class="chip">' + s.license + '</span>');
  return '<div class="entry"><div class="entry-head"><h3>' + s.name + '</h3><div class="badges">' + chips(s.summary) + '</div></div>' +
    (s.description ? '<div class="desc">' + s.description + '</div>' : '') +
    '<div class="entry-links">' + links.join('') + '</div>' +
    '<div class="meta">audited ' + (s.audited_at || '').slice(0, 10) + '</div></div>';
}
function renderCatalog(el, limit) {
  fetch('/api/catalog').then(function (r) { return r.json(); }).then(function (data) {
    var items = data.models || [];
    if (!items.length) {
      el.innerHTML = '<div class="catalog-empty">No certified models yet. Submit the first one.</div>';
      return;
    }
    if (limit) items = items.slice(0, limit);
    el.innerHTML = items.map(entryHtml).join('');
    if (limit && (data.models || []).length > limit) {
      el.innerHTML += '<p style="margin-top:18px"><a class="button button-sm" href="/catalog">View all certified models</a></p>';
    }
  }).catch(function () { el.innerHTML = '<div class="catalog-empty">Failed to load catalog.</div>'; });
}
`;

export const submitClient = `
document.getElementById('submit-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var f = e.target, msg = document.getElementById('form-msg');
  var body = {
    name: f.name.value.trim(),
    description: f.description.value.trim(),
    submitter_email: f.email.value.trim(),
    license: f.license.value.trim(),
    website_url: f.website.value.trim(),
    weights_url: f.weights.value.trim(),
    code_url: f.code.value.trim(),
    data_url: f.data.value.trim(),
  };
  fetch('/api/submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      msg.hidden = false;
      if (res.ok) {
        msg.className = 'msg ok';
        msg.textContent = 'Submitted. An auditor will review it shortly.';
        f.reset();
      } else {
        msg.className = 'msg err';
        msg.textContent = res.d.error || 'Submission failed.';
      }
    }).catch(function () {
      msg.hidden = false; msg.className = 'msg err'; msg.textContent = 'Network error.';
    });
});
`;

export const authClient = `
var form = document.getElementById('signin-form') || document.getElementById('signup-form');
form.addEventListener('submit', function (e) {
  e.preventDefault();
  var f = e.target, msg = document.getElementById('form-msg');
  var endpoint = f.id === 'signup-form' ? '/api/auth/signup' : '/api/auth/signin';
  var code = new URLSearchParams(location.search).get('code') || '';
  var body = { email: f.email.value.trim(), password: f.password.value };
  if (f.id === 'signup-form') { body.name = f.name ? f.name.value.trim() : ''; body.code = code; }
  msg.hidden = false; msg.className = 'msg'; msg.textContent = '…';
  fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (res.ok) { location.href = '/audit'; return; }
      msg.className = 'msg err';
      msg.textContent = res.d.error || 'Authentication failed.';
    }).catch(function () { msg.className = 'msg err'; msg.textContent = 'Network error.'; });
});
`;

export const auditClient = `
var status = new URLSearchParams(location.search).get('status') || 'pending';
document.querySelectorAll('.tab').forEach(function (t) {
  t.classList.toggle('active', t.dataset.status === status);
});
var list = document.getElementById('audit-list');
function labelsHtml(s) {
  var all = ['open_weights', 'open_code', 'open_data', 'closed'];
  return all.map(function (l) {
    var on = (s.labels || []).indexOf(l) !== -1;
    return '<label class="label-check"><input type="checkbox" data-label="' + l + '"' + (on ? ' checked' : '') + '>' + l.replace('_', ' ').replace(/\\b\\w/g, function (m) { return m.toUpperCase(); }) + '</label>';
  }).join('');
}
function linkCell(url, label) {
  if (url) return '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
  return '<span class="nolink">no ' + label + '</span>';
}
function rowHtml(s) {
  return '<div class="su-row" data-id="' + s.id + '">' +
    '<div class="su-head"><span class="su-name">' + s.name + '</span>' +
    '<span class="date">submitted ' + (s.created_at || '').slice(0, 10) + '</span></div>' +
    (s.description ? '<div class="su-desc">' + s.description + '</div>' : '') +
    (s.submitter_email ? '<div class="su-desc muted">' + s.submitter_email + '</div>' : '') +
    '<div class="su-links">' + linkCell(s.website_url, 'site') + linkCell(s.weights_url, 'weights') + linkCell(s.code_url, 'code') + linkCell(s.data_url, 'data') +
      (s.license ? '<span class="chip">' + s.license + '</span>' : '') + '</div>' +
    '<div class="label-checks">' + labelsHtml(s) + '</div>' +
    '<div class="su-notes"><textarea placeholder="Audit notes (optional)">' + (s.audit_notes || '') + '</textarea></div>' +
    '<div class="su-actions"><button class="button button-sm button-primary" data-action="publish">Label & publish</button>' +
    '<button class="button button-sm" data-action="reject">Reject</button><span class="msg" data-msg hidden></span></div>' +
    '</div>';
}
function load() {
  list.innerHTML = '<div class="loading">Loading queue…</div>';
  fetch('/api/submissions?status=' + status, { credentials: 'same-origin' }).then(function (r) {
    if (r.status === 401) { location.href = '/signin'; return; }
    return r.json();
  }).then(function (data) {
    if (!data) return;
    var items = data.submissions || [];
    if (!items.length) { list.innerHTML = '<div class="catalog-empty">Nothing here.</div>'; return; }
    list.innerHTML = items.map(rowHtml).join('');
    list.addEventListener('change', function (e) {
      var input = e.target;
      if (!input.classList || !input.matches('input[data-label]')) return;
      if (input.dataset.label === 'closed' && input.checked) {
        list.querySelectorAll('input[data-label]:not([data-label="closed"])').forEach(function (i) { i.checked = false; });
      } else if (input.checked) {
        var c = list.querySelector('input[data-label="closed"]');
        if (c) c.checked = false;
      }
    });
    list.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.su-row');
        var labels = Array.prototype.filter.call(row.querySelectorAll('input[data-label]:checked'), function (i) { return i.checked; })
          .map(function (i) { return i.dataset.label; });
        var notes = row.querySelector('textarea').value.trim();
        var publish = btn.dataset.action === 'publish';
        var msg = row.querySelector('[data-msg]');
        msg.hidden = false; msg.textContent = '…';
        fetch('/api/submissions/' + row.dataset.id + '/label', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ labels: labels, publish: publish, notes: notes }),
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) {
            if (res.ok) { row.remove(); msg.hidden = true; return; }
            msg.className = 'msg err'; msg.textContent = res.d.error || 'Failed.';
          }).catch(function () { msg.className = 'msg err'; msg.textContent = 'Network error.'; });
      });
    });
  }).catch(function () { list.innerHTML = '<div class="catalog-empty">Failed to load.</div>'; });
}
load();
`;

export function auditPageScript(): string {
  return `
document.querySelector('[data-signout]').addEventListener('click', function (e) {
  e.preventDefault();
  fetch('/api/auth/signout', { method: 'POST', credentials: 'same-origin' }).then(function () { location.href = '/signin'; });
});
`;
}
