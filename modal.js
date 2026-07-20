// Noorani Browser — modal.js
//
// A theme-aware, self-contained confirm-modal module.
// Exposes window.nooraniModal.confirm(opts) -> Promise<boolean>.
//
// Works in any document (file:// chrome, noorani:// internal pages) as long
// as it has access to the DOM. Injects its own <style> on first use, so no
// external CSS is required.
//
// Usage:
//   const ok = await nooraniModal.confirm({
//     title: 'Clear Browsing Data',
//     message: 'This will permanently delete:',
//     details: ['Browsing history', 'Bookmarks'],
//     confirmText: 'Clear Data',
//     variant: 'danger'
//   });
//   if (ok) { ... }

(function () {
  if (window.nooraniModal) return;

  const STYLE_ID = '__noorani_modal_style';
  // Self-contained palette keyed off :root[data-theme] so this works in every
  // Noorani page regardless of which CSS-variable names that page uses.
  const CSS = `
    :root {
      --nm-bg:       #ffffff;
      --nm-text:     #2a2a2a;
      --nm-muted:    #6b6b6b;
      --nm-border:   #e8e2d5;
      --nm-hover:    rgba(0,0,0,0.05);
      --nm-accent:   #c9a961;
      --nm-danger:   #c0392b;
      --nm-danger-h: #a93226;
    }
    :root[data-theme="dark"] {
      --nm-bg:       #252525;
      --nm-text:     #e8e8e8;
      --nm-muted:    #9a9a9a;
      --nm-border:   #3a3a3a;
      --nm-hover:    rgba(255,255,255,0.06);
      --nm-accent:   #d4af37;
      --nm-danger:   #e74c3c;
      --nm-danger-h: #c0392b;
    }

    .noorani-modal__backdrop {
      position: fixed; inset: 0;
      z-index: 99999;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 150ms ease-out;
      font-family: var(--font-sans, 'Inter', -apple-system, BlinkMacSystemFont,
                   "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
    }
    .noorani-modal__backdrop.is-open { opacity: 1; }

    .noorani-modal__card {
      background: var(--nm-bg);
      color: var(--nm-text);
      border: 1px solid var(--nm-border);
      border-radius: 12px;
      width: 100%;
      max-width: 440px;
      margin: 16px;
      padding: 24px 26px 20px;
      box-shadow: 0 20px 48px rgba(0,0,0,0.25);
      transform: translateY(8px) scale(0.98);
      transition: transform 150ms ease-out;
    }
    .noorani-modal__backdrop.is-open .noorani-modal__card {
      transform: translateY(0) scale(1);
    }

    .noorani-modal__title {
      font-family: var(--font-serif, 'DM Serif Display', Georgia, serif);
      font-size: 20px;
      font-weight: 400;
      margin: 0 0 10px 0;
      color: var(--nm-text);
    }
    .noorani-modal__message {
      font-size: 15px;
      line-height: 1.5;
      color: var(--nm-muted);
      margin: 0 0 12px 0;
    }
    .noorani-modal__details {
      margin: 0 0 18px 0;
      padding-left: 22px;
      color: var(--nm-muted);
      font-size: 14px;
      line-height: 1.7;
    }
    .noorani-modal__details li { margin: 0; }

    .noorani-modal__actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 6px;
    }
    .noorani-modal__btn {
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      padding: 9px 18px;
      border-radius: 6px;
      cursor: pointer;
      border: 1px solid transparent;
      outline: none;
      transition: background-color 120ms ease, border-color 120ms ease,
                  box-shadow 120ms ease, filter 120ms ease;
    }
    .noorani-modal__btn:focus-visible {
      box-shadow: 0 0 0 2px var(--nm-accent);
    }
    .noorani-modal__btn--cancel {
      background: transparent;
      color: var(--nm-text);
      border-color: var(--nm-border);
    }
    .noorani-modal__btn--cancel:hover { background: var(--nm-hover); }
    .noorani-modal__btn--confirm {
      background: var(--nm-accent);
      color: #ffffff;
      border-color: var(--nm-accent);
    }
    .noorani-modal__btn--confirm:hover { filter: brightness(0.95); }
    .noorani-modal__btn--danger {
      background: var(--nm-danger);
      color: #ffffff;
      border-color: var(--nm-danger);
    }
    .noorani-modal__btn--danger:hover {
      background: var(--nm-danger-h);
      border-color: var(--nm-danger-h);
    }
    .noorani-modal__btn--danger:focus-visible {
      box-shadow: 0 0 0 2px var(--nm-danger);
    }

    .noorani-modal__input {
      display: block;
      width: 100%;
      font: inherit;
      font-size: 14px;
      padding: 10px 12px;
      margin: 0 0 16px 0;
      color: var(--nm-text);
      background: transparent;
      border: 1px solid var(--nm-border);
      border-radius: 8px;
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .noorani-modal__input:focus {
      border-color: var(--nm-accent);
      box-shadow: 0 0 0 3px rgba(201, 169, 97, 0.2);
    }

    .noorani-modal__field {
      margin: 0 0 14px 0;
    }
    .noorani-modal__field-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--nm-muted);
      margin: 0 0 6px 2px;
    }
    .noorani-modal__field .noorani-modal__input { margin: 0; }
    .noorani-modal__field.has-error .noorani-modal__input {
      border-color: var(--nm-danger);
    }
    .noorani-modal__field-error {
      display: none;
      font-size: 12px;
      color: var(--nm-danger);
      margin-top: 5px;
    }
    .noorani-modal__field.has-error .noorani-modal__field-error {
      display: block;
    }

    .noorani-modal__origin {
      font-size: 12px;
      font-family: 'SFMono-Regular', Consolas, monospace;
      color: var(--nm-muted);
      background: var(--nm-hover);
      border-radius: 6px;
      padding: 6px 10px;
      margin: 0 0 16px 0;
      word-break: break-all;
    }
    .noorani-modal__checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 18px 0;
      font-size: 13px;
      color: var(--nm-text);
    }
    .noorani-modal__checkbox-row input {
      width: 15px; height: 15px;
      accent-color: var(--nm-accent);
      cursor: pointer;
    }
    .noorani-modal__checkbox-row label { cursor: pointer; }
    .noorani-modal__btn--allow {
      background: var(--nm-accent);
      color: #ffffff;
      border-color: var(--nm-accent);
    }
    .noorani-modal__btn--allow:hover { filter: brightness(0.95); }
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function confirmDialog(opts) {
    opts = opts || {};
    const title       = opts.title       || 'Confirm';
    const message     = opts.message     || '';
    const confirmText = opts.confirmText || 'Confirm';
    const cancelText  = opts.cancelText  || 'Cancel';
    const variant     = opts.variant === 'danger' ? 'danger' : 'default';
    const details     = Array.isArray(opts.details) ? opts.details : null;

    injectStyle();

    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'noorani-modal__backdrop';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');

      const card = document.createElement('div');
      card.className = 'noorani-modal__card';

      const h = document.createElement('h2');
      h.className = 'noorani-modal__title';
      h.textContent = title;
      card.appendChild(h);

      if (message) {
        const m = document.createElement('p');
        m.className = 'noorani-modal__message';
        m.textContent = message;
        card.appendChild(m);
      }

      if (details && details.length) {
        const ul = document.createElement('ul');
        ul.className = 'noorani-modal__details';
        for (const d of details) {
          const li = document.createElement('li');
          li.textContent = d;
          ul.appendChild(li);
        }
        card.appendChild(ul);
      }

      const actions = document.createElement('div');
      actions.className = 'noorani-modal__actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'noorani-modal__btn noorani-modal__btn--cancel';
      cancelBtn.textContent = cancelText;

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'noorani-modal__btn ' +
        (variant === 'danger'
          ? 'noorani-modal__btn--danger'
          : 'noorani-modal__btn--confirm');
      confirmBtn.textContent = confirmText;

      actions.append(cancelBtn, confirmBtn);
      card.appendChild(actions);
      backdrop.appendChild(card);

      const prevFocus = document.activeElement;
      let resolved = false;

      function cleanup() {
        document.removeEventListener('keydown', onKey, true);
        backdrop.classList.remove('is-open');
        setTimeout(() => {
          if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
          if (prevFocus && typeof prevFocus.focus === 'function') {
            try { prevFocus.focus(); } catch (_) {}
          }
        }, 150);
      }
      function finish(value) {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(value);
      }

      cancelBtn.addEventListener('click', () => finish(false));
      confirmBtn.addEventListener('click', () => finish(true));

      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) finish(false);
      });

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        } else if (e.key === 'Enter') {
          if (document.activeElement !== cancelBtn) {
            e.preventDefault();
            e.stopPropagation();
            finish(true);
          }
        } else if (e.key === 'Tab') {
          // Focus trap — cycle between cancel and confirm only.
          e.preventDefault();
          if (document.activeElement === cancelBtn) confirmBtn.focus();
          else cancelBtn.focus();
        }
      }
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(backdrop);
      // Force reflow, then animate in.
      // eslint-disable-next-line no-unused-expressions
      backdrop.offsetHeight;
      backdrop.classList.add('is-open');

      // Cancel gets focus first — safer default for destructive actions.
      setTimeout(() => cancelBtn.focus(), 0);
    });
  }

  // Prompt — same shell as confirm(), but with a text input between the
  // message and the action buttons. Resolves to the trimmed string on
  // confirm, or null on cancel (Escape, backdrop click, Cancel button).
  function promptDialog(opts) {
    opts = opts || {};
    const title        = opts.title        || 'Edit';
    const message      = opts.message      || '';
    const confirmText  = opts.confirmText  || 'Save';
    const cancelText   = opts.cancelText   || 'Cancel';
    const placeholder  = opts.placeholder  || '';
    const defaultValue = opts.defaultValue || '';

    injectStyle();

    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'noorani-modal__backdrop';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');

      const card = document.createElement('div');
      card.className = 'noorani-modal__card';

      const h = document.createElement('h2');
      h.className = 'noorani-modal__title';
      h.textContent = title;
      card.appendChild(h);

      if (message) {
        const m = document.createElement('p');
        m.className = 'noorani-modal__message';
        m.textContent = message;
        card.appendChild(m);
      }

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'noorani-modal__input';
      input.value = defaultValue;
      input.placeholder = placeholder;
      input.spellcheck = false;
      card.appendChild(input);

      const actions = document.createElement('div');
      actions.className = 'noorani-modal__actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'noorani-modal__btn noorani-modal__btn--cancel';
      cancelBtn.textContent = cancelText;

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'noorani-modal__btn noorani-modal__btn--confirm';
      confirmBtn.textContent = confirmText;

      actions.append(cancelBtn, confirmBtn);
      card.appendChild(actions);
      backdrop.appendChild(card);

      const prevFocus = document.activeElement;
      let resolved = false;

      function cleanup() {
        document.removeEventListener('keydown', onKey, true);
        backdrop.classList.remove('is-open');
        setTimeout(() => {
          if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
          if (prevFocus && typeof prevFocus.focus === 'function') {
            try { prevFocus.focus(); } catch (_) {}
          }
        }, 150);
      }
      function finish(value) {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(value);
      }

      cancelBtn.addEventListener('click', () => finish(null));
      confirmBtn.addEventListener('click', () => finish(input.value.trim()));

      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) finish(null);
      });

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        } else if (e.key === 'Enter' && document.activeElement === input) {
          e.preventDefault();
          e.stopPropagation();
          finish(input.value.trim());
        }
      }
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(backdrop);
      backdrop.offsetHeight;
      backdrop.classList.add('is-open');

      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }

  // Multi-field form modal. Resolves to an object { [key]: trimmedValue }
  // on save, or null on cancel. Each field may provide a validate(value)
  // that returns an error string or null. Validation runs on save; if any
  // field errors, the modal stays open and highlights the offender(s).
  //
  //   const result = await nooraniModal.form({
  //     title: 'Edit Bookmark',
  //     fields: [
  //       { key: 'title', label: 'Title', value: entry.title },
  //       { key: 'url',   label: 'URL',   value: entry.url, type: 'url',
  //         validate: (v) => /^(https?|noorani):\/\//i.test(v) ? null : 'Enter a valid URL' }
  //     ],
  //     confirmText: 'Save'
  //   });
  function formDialog(opts) {
    opts = opts || {};
    const title       = opts.title       || 'Edit';
    const message     = opts.message     || '';
    const fields      = Array.isArray(opts.fields) ? opts.fields : [];
    const confirmText = opts.confirmText || 'Save';
    const cancelText  = opts.cancelText  || 'Cancel';

    injectStyle();

    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'noorani-modal__backdrop';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');

      const card = document.createElement('div');
      card.className = 'noorani-modal__card';

      const h = document.createElement('h2');
      h.className = 'noorani-modal__title';
      h.textContent = title;
      card.appendChild(h);

      if (message) {
        const m = document.createElement('p');
        m.className = 'noorani-modal__message';
        m.textContent = message;
        card.appendChild(m);
      }

      const inputs = [];
      for (const f of fields) {
        if (!f || !f.key) continue;
        const wrap = document.createElement('div');
        wrap.className = 'noorani-modal__field';

        const label = document.createElement('label');
        label.className = 'noorani-modal__field-label';
        label.textContent = f.label || f.key;
        wrap.appendChild(label);

        const input = document.createElement('input');
        input.type = f.type || 'text';
        input.className = 'noorani-modal__input';
        input.value = (f.value != null) ? f.value : '';
        if (f.placeholder) input.placeholder = f.placeholder;
        input.spellcheck = false;
        wrap.appendChild(input);

        const err = document.createElement('div');
        err.className = 'noorani-modal__field-error';
        wrap.appendChild(err);

        card.appendChild(wrap);
        inputs.push({ field: f, input, wrap, err });
      }

      const actions = document.createElement('div');
      actions.className = 'noorani-modal__actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'noorani-modal__btn noorani-modal__btn--cancel';
      cancelBtn.textContent = cancelText;

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'noorani-modal__btn noorani-modal__btn--confirm';
      confirmBtn.textContent = confirmText;

      actions.append(cancelBtn, confirmBtn);
      card.appendChild(actions);
      backdrop.appendChild(card);

      const prevFocus = document.activeElement;
      let resolved = false;

      function cleanup() {
        document.removeEventListener('keydown', onKey, true);
        backdrop.classList.remove('is-open');
        setTimeout(() => {
          if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
          if (prevFocus && typeof prevFocus.focus === 'function') {
            try { prevFocus.focus(); } catch (_) {}
          }
        }, 150);
      }
      function finish(value) {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(value);
      }
      function attemptSave() {
        const values = {};
        let firstError = null;
        for (const { field, input, wrap, err } of inputs) {
          const v = (input.value || '').trim();
          values[field.key] = v;
          let errText = null;
          if (typeof field.validate === 'function') errText = field.validate(v);
          if (errText) {
            wrap.classList.add('has-error');
            err.textContent = errText;
            if (!firstError) firstError = input;
          } else {
            wrap.classList.remove('has-error');
            err.textContent = '';
          }
        }
        if (firstError) { firstError.focus(); firstError.select(); return; }
        finish(values);
      }

      cancelBtn.addEventListener('click', () => finish(null));
      confirmBtn.addEventListener('click', attemptSave);

      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) finish(null);
      });

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        } else if (e.key === 'Enter' &&
                   inputs.some(({ input }) => document.activeElement === input)) {
          e.preventDefault();
          attemptSave();
        }
      }
      document.addEventListener('keydown', onKey, true);

      // Live-clear error styling as the user types.
      for (const { input, wrap, err } of inputs) {
        input.addEventListener('input', () => {
          wrap.classList.remove('has-error');
          err.textContent = '';
        });
      }

      document.body.appendChild(backdrop);
      backdrop.offsetHeight;
      backdrop.classList.add('is-open');

      setTimeout(() => {
        if (inputs[0]) { inputs[0].input.focus(); inputs[0].input.select(); }
      }, 0);
    });
  }

  // Permission dialog — Allow/Deny with a "remember for this site" checkbox.
  // Resolves to { action: 'allow' | 'deny', remember: boolean }. Dismissing
  // (Escape / backdrop click) counts as Deny with remember left at its
  // default, matching the safe-default posture everywhere else in this file.
  //
  //   const result = await nooraniModal.permission({
  //     title:  'web.whatsapp.com wants to use your camera and microphone',
  //     origin: 'https://web.whatsapp.com',
  //     rememberDefault: true
  //   });
  function permissionDialog(opts) {
    opts = opts || {};
    const title  = opts.title  || 'Permission request';
    const origin = opts.origin || '';
    const rememberLabel = opts.rememberLabel || 'Remember for this site';
    const allowText = opts.allowText || 'Allow';
    const denyText  = opts.denyText  || 'Deny';
    const rememberDefault = opts.rememberDefault !== false;

    injectStyle();

    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'noorani-modal__backdrop';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');

      const card = document.createElement('div');
      card.className = 'noorani-modal__card';

      const h = document.createElement('h2');
      h.className = 'noorani-modal__title';
      h.textContent = title;
      card.appendChild(h);

      if (origin) {
        const o = document.createElement('div');
        o.className = 'noorani-modal__origin';
        o.textContent = origin;
        card.appendChild(o);
      }

      const checkRow = document.createElement('div');
      checkRow.className = 'noorani-modal__checkbox-row';
      const checkId = 'nm-remember-' + Math.random().toString(36).slice(2, 8);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = checkId;
      checkbox.checked = rememberDefault;
      const checkLabel = document.createElement('label');
      checkLabel.htmlFor = checkId;
      checkLabel.textContent = rememberLabel;
      checkRow.append(checkbox, checkLabel);
      card.appendChild(checkRow);

      const actions = document.createElement('div');
      actions.className = 'noorani-modal__actions';

      const denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.className = 'noorani-modal__btn noorani-modal__btn--cancel';
      denyBtn.textContent = denyText;

      const allowBtn = document.createElement('button');
      allowBtn.type = 'button';
      allowBtn.className = 'noorani-modal__btn noorani-modal__btn--allow';
      allowBtn.textContent = allowText;

      actions.append(denyBtn, allowBtn);
      card.appendChild(actions);
      backdrop.appendChild(card);

      const prevFocus = document.activeElement;
      let resolved = false;

      function cleanup() {
        document.removeEventListener('keydown', onKey, true);
        backdrop.classList.remove('is-open');
        setTimeout(() => {
          if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
          if (prevFocus && typeof prevFocus.focus === 'function') {
            try { prevFocus.focus(); } catch (_) {}
          }
        }, 150);
      }
      function finish(action) {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({ action, remember: checkbox.checked });
      }

      denyBtn.addEventListener('click',  () => finish('deny'));
      allowBtn.addEventListener('click', () => finish('allow'));

      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) finish('deny');
      });

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish('deny');
        } else if (e.key === 'Enter') {
          if (document.activeElement !== denyBtn) {
            e.preventDefault();
            e.stopPropagation();
            finish('allow');
          }
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const order = [checkbox, denyBtn, allowBtn];
          const idx = order.indexOf(document.activeElement);
          order[(idx + 1) % order.length].focus();
        }
      }
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(backdrop);
      backdrop.offsetHeight;
      backdrop.classList.add('is-open');

      setTimeout(() => denyBtn.focus(), 0);
    });
  }

  window.nooraniModal = {
    confirm:    confirmDialog,
    prompt:     promptDialog,
    form:       formDialog,
    permission: permissionDialog
  };
})();
