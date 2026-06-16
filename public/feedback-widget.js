(function () {
  const script = document.currentScript;
  const FORMSPREE_ID = script?.dataset.formspreeId;
  const KOFI_HANDLE  = script?.dataset.kofi;

  const CSS = `
    #fw-wrap * { box-sizing: border-box; font-family: 'JetBrains Mono', ui-monospace, monospace; }
    #fw-wrap {
      position: fixed; bottom: 20px; right: 20px; z-index: 99999;
      display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
    }
    #fw-btn {
      background: #22c55e; color: #000; border: none; border-radius: 999px;
      padding: 9px 16px; font-size: 11px; font-weight: 700; letter-spacing: .12em;
      cursor: pointer; display: flex; align-items: center; gap: 6px;
      box-shadow: 0 2px 12px rgba(34,197,94,.3); transition: transform .15s, box-shadow .15s;
    }
    #fw-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 18px rgba(34,197,94,.45); }
    #fw-panel {
      position: relative; background: #111; border: 1px solid #2a2a2a;
      border-radius: 14px; padding: 16px; width: 270px;
      box-shadow: 0 8px 32px rgba(0,0,0,.7);
      animation: fw-in .18s ease;
    }
    @keyframes fw-in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
    #fw-panel h3 {
      margin: 0 0 12px; font-size: 10px; letter-spacing: .18em;
      color: #666; text-transform: uppercase;
    }
    #fw-close {
      position: absolute; top: 12px; right: 14px;
      background: none; border: none; color: #555; font-size: 18px;
      line-height: 1; cursor: pointer; padding: 0;
    }
    #fw-close:hover { color: #aaa; }
    #fw-textarea {
      width: 100%; background: #1a1a1a; border: 1px solid #252525;
      border-radius: 8px; padding: 10px 12px; color: #f0f0f0;
      font-size: 12px; line-height: 1.55; resize: none; outline: none; display: block;
    }
    #fw-textarea:focus { border-color: #3a3a3a; }
    #fw-textarea::placeholder { color: #444; }
    #fw-submit {
      margin-top: 8px; width: 100%; padding: 9px; border: none; border-radius: 8px;
      background: #22c55e; color: #000; font-size: 11px; font-weight: 700;
      letter-spacing: .1em; cursor: pointer; transition: opacity .15s;
    }
    #fw-submit:hover { opacity: .88; }
    #fw-submit:disabled { opacity: .4; cursor: default; }
    #fw-status { font-size: 11px; margin-top: 7px; text-align: center; min-height: 15px; }
    .fw-ok  { color: #22c55e; }
    .fw-err { color: #ef4444; }
    .fw-sep {
      display: flex; align-items: center; gap: 8px; margin: 14px 0;
      font-size: 10px; color: #3a3a3a; letter-spacing: .1em;
    }
    .fw-sep::before, .fw-sep::after { content:''; flex:1; height:1px; background:#222; }
    #fw-kofi {
      display: flex; align-items: center; justify-content: center; gap: 7px;
      width: 100%; padding: 9px; border-radius: 8px; border: 1px solid #252525;
      background: transparent; color: #ccc; font-size: 11px; font-weight: 600;
      letter-spacing: .08em; text-decoration: none;
      transition: border-color .15s, background .15s, color .15s;
    }
    #fw-kofi:hover { border-color: #444; background: #1a1a1a; color: #fff; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // --- toggle state ---
  let open = false;
  let panel = null;

  function buildPanel() {
    const p = document.createElement('div');
    p.id = 'fw-panel';

    let inner = `<button id="fw-close" title="Close">&times;</button><h3>Feedback</h3>`;

    if (FORMSPREE_ID) {
      inner += `
        <textarea id="fw-textarea" rows="4" placeholder="Suggestion or comment…"></textarea>
        <button id="fw-submit">SEND</button>
        <div id="fw-status"></div>
      `;
    }

    if (FORMSPREE_ID && KOFI_HANDLE) {
      inner += `<div class="fw-sep">OR</div>`;
    }

    if (KOFI_HANDLE) {
      inner += `
        <a id="fw-kofi" href="https://ko-fi.com/${KOFI_HANDLE}" target="_blank" rel="noopener">
          ☕ Buy me a coffee
        </a>
      `;
    }

    p.innerHTML = inner;

    p.querySelector('#fw-close').addEventListener('click', () => toggle(false));

    if (FORMSPREE_ID) {
      const submitBtn = p.querySelector('#fw-submit');
      const textarea  = p.querySelector('#fw-textarea');
      const status    = p.querySelector('#fw-status');

      submitBtn.addEventListener('click', async () => {
        const msg = textarea.value.trim();
        if (!msg) return;
        submitBtn.disabled = true;
        status.textContent = '';
        try {
          const res = await fetch(`https://formspree.io/f/${FORMSPREE_ID}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ message: msg, page: location.href }),
          });
          if (!res.ok) throw new Error();
          textarea.value = '';
          status.textContent = 'Sent — thanks!';
          status.className = 'fw-ok';
        } catch {
          status.textContent = 'Failed to send. Try again.';
          status.className = 'fw-err';
        }
        submitBtn.disabled = false;
      });
    }

    return p;
  }

  function toggle(state) {
    open = (state !== undefined) ? state : !open;
    if (open) {
      if (!panel) {
        panel = buildPanel();
        wrap.insertBefore(panel, btn);
      }
      panel.style.display = 'block';
    } else if (panel) {
      panel.style.display = 'none';
    }
  }

  // --- assemble ---
  const wrap = document.createElement('div');
  wrap.id = 'fw-wrap';

  const btn = document.createElement('button');
  btn.id = 'fw-btn';
  btn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
    FEEDBACK
  `;
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });

  document.addEventListener('click', (e) => {
    if (open && !wrap.contains(e.target)) toggle(false);
  });

  wrap.appendChild(btn);
  document.body.appendChild(wrap);
})();
