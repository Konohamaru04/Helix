const statusEl = document.getElementById('status');
const detailEl = document.getElementById('detail');

const steps = [
  {
    status: 'Bootstrapping local services',
    detail: 'Opening the bridge, database, tool surface, and renderer.'
  },
  {
    status: 'Preparing desktop state',
    detail: 'Restoring workspace metadata, settings, and conversation history.'
  },
  {
    status: 'Opening the chat surface',
    detail: 'Warming the renderer so the main window can appear fully framed.'
  }
];

let currentStep = 0;

window.setInterval(() => {
  currentStep = (currentStep + 1) % steps.length;
  const nextStep = steps[currentStep];

  if (!nextStep) return;

  if (statusEl) {
    statusEl.textContent = nextStep.status;
  }

  if (detailEl) {
    detailEl.textContent = nextStep.detail;
  }
}, 1400);
