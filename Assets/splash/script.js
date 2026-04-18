const statusEl = document.getElementById('status');
const detailEl = document.getElementById('detail');
const progressFillEl = document.getElementById('progressFill');

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
