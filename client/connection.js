// IDLE.SYS Discord Connection Module
'use strict';

const ConnectionModule = (() => {
  let _send = null;
  let _codeTimer = null;

  function init(opts) {
    _send = opts.send;
  }

  function startOAuth() {
    if (!_send) return;
    _send({ type: 'action', action: 'discord_oauth_start' });
  }

  function delink() {
    if (!_send) return;
    if (!confirm('Unlink your Discord account from IDLE.SYS?')) return;
    _send({ type: 'action', action: 'delink_discord' });
  }

  function handleMessage(msg) {
    if (msg.type === 'action_ok' && msg.action === 'discord_oauth_start') {
      if (window.electron?.openExternal) {
        window.electron.openExternal(msg.url);
      } else {
        window.open(msg.url, '_blank');
      }
    } else if (msg.type === 'action_ok' && msg.action === 'delink_discord') {
      updateStatus(msg.state);
    } else if (msg.type === 'discord_linked') {
      _showLinked(msg.discord_name);
    }
  }

  function updateStatus(state) {
    const statusEl  = document.getElementById('discord-link-status');
    const unlinked  = document.getElementById('discord-unlinked-section');
    const linked    = document.getElementById('discord-linked-section');
    if (!statusEl) return;
    if (state && state.discord_id) {
      const label = state.discord_name ? `Linked to ${state.discord_name}` : 'Linked to Discord';
      statusEl.textContent = '✅ ' + label;
      statusEl.style.color = 'var(--green)';
      if (unlinked) unlinked.style.display = 'none';
      if (linked)   linked.style.display   = 'block';
    } else {
      statusEl.textContent = '⚫ Not linked';
      statusEl.style.color = 'var(--muted)';
      if (unlinked) unlinked.style.display = 'block';
      if (linked)   linked.style.display   = 'none';
    }
  }

  function _showLinked(discordName) {
    if (_codeTimer) { clearInterval(_codeTimer); _codeTimer = null; }
    const statusEl = document.getElementById('discord-link-status');
    if (statusEl) {
      statusEl.textContent = `✅ Linked to Discord (${discordName || 'connected'})`;
      statusEl.style.color = 'var(--green)';
    }
    const unlinked = document.getElementById('discord-unlinked-section');
    const linked   = document.getElementById('discord-linked-section');
    if (unlinked) unlinked.style.display = 'none';
    if (linked)   linked.style.display   = 'block';
  }

  function _fmtTime(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  return { init, startOAuth, delink, handleMessage, updateStatus };
})();
