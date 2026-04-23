const statusEl = document.getElementById('status');
const detailEl = document.getElementById('detail');
const progressFillEl = document.getElementById('progressFill');
const updateStatusEl = document.getElementById('updateStatus');

const steps = [
  {
    status: 'Preparing startup',
    detail: 'Opening the splash and validating the local runtime.'
  },
  {
    status: 'Checking Python packages',
    detail: 'Verifying deferred packages before the local inference server starts.'
  },
  {
    status: 'Opening the chat surface',
    detail: 'Launching local services and preparing the main window.'
  }
];

let currentStep = 0;
let fallbackTimer = null;

function applyState(nextStep) {
  if (!nextStep) return;

  if (statusEl) {
    statusEl.textContent = nextStep.status;
  }

  if (detailEl) {
    detailEl.textContent = nextStep.detail;
  }

  if (!progressFillEl) {
    return;
  }

  if (typeof nextStep.progress === 'number') {
    const clamped = Math.min(100, Math.max(0, Math.round(nextStep.progress * 100)));
    progressFillEl.classList.remove('is-indeterminate');
    progressFillEl.style.width = `${clamped}%`;
    return;
  }

  progressFillEl.classList.add('is-indeterminate');
  progressFillEl.style.width = '';
}

function startFallbackRotation() {
  fallbackTimer = window.setInterval(() => {
    currentStep = (currentStep + 1) % steps.length;
    applyState(steps[currentStep]);
  }, 1400);
}

applyState(steps[currentStep]);
startFallbackRotation();

window.helixSplash?.onStatusUpdate((nextStep) => {
  if (fallbackTimer !== null) {
    window.clearInterval(fallbackTimer);
    fallbackTimer = null;
  }

  applyState(nextStep);
});

function setUpdateState(variant, text, title) {
  if (!updateStatusEl) return;
  updateStatusEl.classList.remove('is-checking', 'is-new', 'is-ok', 'is-error');
  updateStatusEl.classList.add(`is-${variant}`);
  updateStatusEl.textContent = text;
  if (title) {
    updateStatusEl.title = title;
  } else {
    updateStatusEl.removeAttribute('title');
  }
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderUpdate(result) {
  if (!result) {
    setUpdateState('error', 'Update check unavailable');
    return;
  }

  const current = result.currentVersion ? `v${result.currentVersion.replace(/^v/i, '')}` : '';

  if (result.error && !result.latestVersion && !result.latestCommit) {
    setUpdateState('error', `Update check failed · ${current}`, result.error);
    return;
  }

  if (result.hasUpdate && result.latestVersion) {
    const published = formatDate(result.publishedAt);
    const suffix = published ? ` · ${published}` : '';
    setUpdateState(
      'new',
      `Update available — ${result.latestVersion} (you have ${current})${suffix}`,
      result.releaseUrl ?? undefined
    );
    return;
  }

  if (result.latestCommit) {
    const when = formatDate(result.latestCommit.date);
    const label = result.latestVersion
      ? `Up to date · ${current}`
      : `On latest commit · ${current}`;
    const commitInfo = `${result.latestCommit.sha}${when ? ` · ${when}` : ''}`;
    setUpdateState('ok', `${label} · ${commitInfo}`, result.latestCommit.message);
    return;
  }

  if (result.latestVersion) {
    setUpdateState('ok', `Up to date · ${current} (latest ${result.latestVersion})`);
    return;
  }

  setUpdateState('ok', `Running ${current}`);
}

if (window.helixSplash?.checkForUpdates) {
  window.helixSplash
    .checkForUpdates()
    .then(renderUpdate)
    .catch((error) => {
      setUpdateState('error', 'Update check failed', error?.message ?? String(error));
    });
} else {
  setUpdateState('error', 'Update check unavailable');
}
