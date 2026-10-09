const form = document.querySelector('#job-form');
const startButton = document.querySelector('#start-button');
const formError = document.querySelector('#form-error');
const jobPanel = document.querySelector('#job-panel');
const jobTitle = document.querySelector('#job-title');
const jobIdLabel = document.querySelector('#job-id');
const jobState = document.querySelector('#job-state');
const jobMessage = document.querySelector('#job-message');
const progressBar = document.querySelector('#progress-bar');
const jobLog = document.querySelector('#job-log');
const previewWrap = document.querySelector('#preview-wrap');
const preview = document.querySelector('#preview');
const outputHash = document.querySelector('#output-hash');
const approveButton = document.querySelector('#approve-button');
const blockedReason = document.querySelector('#blocked-reason');
const blockedReasonText = document.querySelector('#blocked-reason-text');
const stages = [...document.querySelectorAll('#stages li')];
const useOllamaToggle = document.querySelector('#use-ollama');
const ollamaModel = document.querySelector('#ollama-model');
const customOllamaModel = document.querySelector('#custom-ollama-model');
const personalPermissionToggle = document.querySelector('#personal-permission');
const permissionNote = document.querySelector('#permission-note');
const queueCount = document.querySelector('#queue-count');
const queueEmpty = document.querySelector('#queue-empty');
const queueList = document.querySelector('#queue-list');

let currentJob = null;
let pollTimer = null;
let queueTimer = null;

function syncOllamaState() {
  const enabled = useOllamaToggle.checked;
  const custom = ollamaModel.value === 'custom';
  ollamaModel.disabled = !enabled;
  customOllamaModel.hidden = !enabled || !custom;
  customOllamaModel.disabled = !enabled || !custom;
}

useOllamaToggle.addEventListener('change', syncOllamaState);
ollamaModel.addEventListener('change', syncOllamaState);
syncOllamaState();

function syncPermissionState() {
  permissionNote.disabled = !personalPermissionToggle.checked;
}

personalPermissionToggle.addEventListener('change', syncPermissionState);
syncPermissionState();

function selectedOllamaModel() {
  return ollamaModel.value === 'custom' ? customOllamaModel.value.trim() : ollamaModel.value;
}

const stageOrder = ['queued', 'validating', 'transcribing', 'planning', 'matching', 'rendering', 'checking', 'ready-for-review', 'approved'];
const stageNames = {
  queued: '대기열에 넣음',
  validating: '소스와 권리 메타데이터 확인 중',
  transcribing: '영어 자막 준비 중',
  planning: '문맥을 지키며 핵심 구간을 선별 중',
  matching: '자료 연결을 확인 중',
  rendering: 'Remotion으로 검토본 렌더링 중',
  checking: '영상 품질을 확인 중',
  'ready-for-review': '검토본 준비 완료',
  approved: '승인 기록 완료',
  blocked: '작업 중단 · 확인 필요',
};
const queueStateNames = {
  queued: '대기 중',
  validating: '소스 확인 중',
  transcribing: '자막 준비 중',
  planning: '핵심 선별 중',
  matching: '자료 연결 확인 중',
  rendering: '렌더링 중',
  checking: '품질 확인 중',
  'ready-for-review': '검토 가능',
  approved: '승인 완료',
  blocked: '차단됨',
};

function setFormError(message = '') {
  formError.textContent = message;
}

function setJobState(status) {
  const state = status.state || 'unknown';
  jobState.textContent = state.toUpperCase();
  jobState.dataset.state = state;
  jobTitle.textContent = state === 'blocked' ? '확인이 필요한 작업' : stageNames[state] || '작업 진행 중';
  if (state === 'queued' && status.queuePosition) {
    jobMessage.textContent = `대기열 ${status.queuePosition}번 · 작업이 순서대로 시작돼.`;
  } else {
    jobMessage.textContent = status.error || stageNames[state] || '상태 확인 중…';
  }
  const blocked = state === 'blocked' ? status.blocked : null;
  if (blocked) {
    const details = [
      blocked.stage ? `단계: ${stageNames[blocked.stage] || blocked.stage}` : '',
      blocked.reason ? `코드: ${blocked.reason}` : '',
      blocked.errorCode ? `오류 코드: ${blocked.errorCode}` : '',
      Array.isArray(blocked.critical) && blocked.critical.length > 0
        ? `검사: ${blocked.critical.join(', ')}`
        : '',
      blocked.message || status.error || '',
    ].filter(Boolean);
    blockedReasonText.textContent = details.join(' · ');
    blockedReason.hidden = details.length === 0;
  } else {
    blockedReasonText.textContent = '';
    blockedReason.hidden = true;
  }
  const index = Math.max(0, stageOrder.indexOf(state));
  const percent = state === 'ready-for-review' || state === 'approved' ? 100 : Math.min(96, Math.round((index / 7) * 100));
  progressBar.style.width = `${percent}%`;
  stages.forEach((item) => {
    const stage = item.dataset.state;
    const stageIndex = stageOrder.indexOf(stage);
    item.dataset.progress = stageIndex < index ? 'done' : stageIndex === index ? 'active' : 'pending';
    item.querySelector('em').textContent = stageIndex < index ? '완료' : stageIndex === index ? '진행 중' : '대기';
  });
  if (Array.isArray(status.warnings) && status.warnings.length > 0) {
    jobLog.textContent = `검토 경고\n${status.warnings.join('\n')}`;
  }
  if (status.outputSha256) outputHash.textContent = status.outputSha256;
  const ready = state === 'ready-for-review' || state === 'approved';
  if (ready && status.previewUrl) {
    previewWrap.hidden = false;
    if (!preview.src.endsWith(status.previewUrl)) preview.src = `${status.previewUrl}?v=${encodeURIComponent(status.version || 'v001')}`;
    approveButton.disabled = state === 'approved';
    approveButton.textContent = state === 'approved' ? '승인 기록 완료' : '검토 완료 · 승인 기록';
  } else if (!ready) {
    previewWrap.hidden = true;
    preview.removeAttribute('src');
    approveButton.disabled = true;
    approveButton.textContent = '검토 완료 · 승인 기록';
  }
}

function clearPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function openJob(job) {
  if (!job?.jobId) return;
  clearPolling();
  currentJob = {
    jobId: job.jobId,
    statusUrl: job.statusUrl || `/api/jobs/${encodeURIComponent(job.jobId)}`,
  };
  jobPanel.hidden = false;
  jobIdLabel.textContent = job.jobId;
  jobLog.textContent = '상태를 불러오는 중…';
  previewWrap.hidden = true;
  blockedReason.hidden = true;
  void fetchStatus();
  pollTimer = setInterval(fetchStatus, 2000);
}

function renderQueue(payload) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const queued = Number(payload?.queuedCount) || 0;
  const active = Number(payload?.activeCount) || 0;
  const blocked = Number(payload?.blockedCount) || 0;
  queueCount.textContent = blocked > 0
    ? `대기 ${queued} · 실행 ${active} · 차단 ${blocked} (숨김)`
    : `대기 ${queued} · 실행 ${active}`;
  queueEmpty.hidden = jobs.length > 0;
  if (jobs.length === 0) {
    queueEmpty.textContent = blocked > 0
      ? `대기 중인 작업이 없어. 차단된 ${blocked}개는 대기열에서 자동 제외했어.`
      : '아직 등록된 작업이 없어.';
  }
  queueList.replaceChildren();
  for (const job of jobs) {
    const item = document.createElement('li');
    item.className = 'queue-item';
    item.dataset.state = job.state || 'unknown';
    const marker = document.createElement('span');
    marker.className = 'queue-marker';
    marker.textContent = job.queuePosition ? String(job.queuePosition).padStart(2, '0') : '·';
    const details = document.createElement('div');
    details.className = 'queue-item-details';
    const title = document.createElement('strong');
    title.textContent = job.jobId || '알 수 없는 작업';
    const state = document.createElement('span');
    state.textContent = queueStateNames[job.state] || job.state || '상태 확인 중';
    details.append(title, state);
    if (job.state === 'blocked' && (job.blocked?.message || job.blocked?.stage || job.blocked?.reason || job.error)) {
      const reason = document.createElement('small');
      reason.textContent = [
        job.blocked?.stage ? `단계: ${stageNames[job.blocked.stage] || job.blocked.stage}` : '',
        job.blocked?.reason ? `코드: ${job.blocked.reason}` : '',
        Array.isArray(job.blocked?.critical) && job.blocked.critical.length > 0
          ? `검사: ${job.blocked.critical.join(', ')}`
          : '',
        job.blocked?.message || job.error || '',
      ].filter(Boolean).join(' · ');
      details.append(reason);
    }
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'queue-open';
    openButton.textContent = '열기';
    openButton.addEventListener('click', () => openJob(job));
    item.append(marker, details, openButton);
    queueList.append(item);
  }
}

async function fetchQueue() {
  try {
    const response = await fetch('/api/jobs', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || '대기열을 읽을 수 없어.');
    renderQueue(payload);
  } catch (error) {
    queueEmpty.hidden = false;
    queueEmpty.textContent = error.message;
    queueCount.textContent = '확인 실패';
  }
}

async function fetchStatus() {
  if (!currentJob) return;
  try {
    const response = await fetch(currentJob.statusUrl, { cache: 'no-store' });
    const status = await response.json();
    if (!response.ok) throw new Error(status.message || '상태를 읽을 수 없어.');
    setJobState(status);
    if (status.state === 'ready-for-review' || status.state === 'approved' || status.state === 'blocked') {
      clearPolling();
    }
  } catch (error) {
    jobMessage.textContent = error.message;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormError('');
  startButton.disabled = true;
  startButton.querySelector('span').textContent = '작업 생성 중…';
  const body = {
    youtubeUrl: document.querySelector('#youtube-url').value.trim(),
    targetDurationSec: Number(document.querySelector('#target-duration').value),
    useOllama: document.querySelector('#use-ollama').checked,
    ollamaModel: selectedOllamaModel(),
    personalPermission: personalPermissionToggle.checked,
    permissionNote: permissionNote.value.trim(),
  };
  if (body.useOllama && !body.ollamaModel) {
    startButton.disabled = false;
    startButton.querySelector('span').textContent = '편집 시작';
    setFormError('직접 입력한 Ollama 모델 이름을 적어줘.');
    return;
  }
  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '작업을 시작할 수 없어.');
    currentJob = result;
    jobPanel.hidden = false;
    jobIdLabel.textContent = result.jobId;
    jobLog.textContent = '작업 생성됨. 상태를 기다리는 중…';
    setJobState(result);
    startButton.disabled = false;
    startButton.querySelector('span').textContent = '새 작업 추가';
    await fetchStatus();
    clearPolling();
    pollTimer = setInterval(fetchStatus, 2000);
    await fetchQueue();
  } catch (error) {
    startButton.disabled = false;
    startButton.querySelector('span').textContent = '편집 시작';
    setFormError(error.message);
  }
});

void fetchQueue();
queueTimer = setInterval(fetchQueue, 2000);

approveButton.addEventListener('click', async () => {
  if (!currentJob || approveButton.disabled) return;
  approveButton.disabled = true;
  try {
    const status = await (await fetch(currentJob.statusUrl, { cache: 'no-store' })).json();
    const response = await fetch(`${currentJob.statusUrl}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: status.version, outputSha256: status.outputSha256 }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '승인 기록에 실패했어.');
    setJobState(result);
  } catch (error) {
    approveButton.disabled = false;
    jobMessage.textContent = error.message;
  }
});
