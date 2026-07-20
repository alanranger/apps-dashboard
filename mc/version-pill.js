(function loadBuildPill() {
  const verEl = document.getElementById('gitVersion');
  const builtEl = document.getElementById('buildDate');
  const loadedEl = document.getElementById('loadTimeValue');
  if (!verEl || !builtEl || !loadedEl) return;

  loadedEl.textContent = new Date().toLocaleTimeString();

  fetch('/api/version')
    .then((r) => r.json())
    .then((d) => {
      verEl.textContent = d.commitHash || 'local';
      if (d.deploymentTimestamp) {
        const dt = new Date(d.deploymentTimestamp);
        builtEl.textContent = dt.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' GMT');
      } else {
        builtEl.textContent = '—';
      }
    })
    .catch(() => {
      verEl.textContent = 'local';
      builtEl.textContent = '—';
    });
})();
